import { prisma } from "./db"

export interface PreferenceData {
  blacklist: string[]
  whitelist: string[]
  notes: string[]
}

function parse(raw: { blacklist: string; whitelist: string; notes: string }): PreferenceData {
  return {
    blacklist: JSON.parse(raw.blacklist),
    whitelist: JSON.parse(raw.whitelist),
    notes: JSON.parse(raw.notes),
  }
}

export async function getPreferences(userId: string): Promise<PreferenceData> {
  const pref = await prisma.preference.findUnique({ where: { userId } })
  if (!pref) return { blacklist: [], whitelist: [], notes: [] }
  return parse(pref)
}

export async function savePreference(
  userId: string,
  type: "blacklist" | "whitelist" | "notes",
  value: string
) {
  const existing = await prisma.preference.findUnique({ where: { userId } })
  const current: string[] = existing ? JSON.parse(existing[type]) : []
  if (current.includes(value)) return
  const updated = JSON.stringify([...current, value])
  await prisma.preference.upsert({
    where: { userId },
    create: {
      userId,
      blacklist: type === "blacklist" ? updated : "[]",
      whitelist: type === "whitelist" ? updated : "[]",
      notes: type === "notes" ? updated : "[]",
    },
    update: { [type]: updated },
  })
}

export async function deletePreference(
  userId: string,
  type: "blacklist" | "whitelist" | "notes",
  value: string
) {
  const existing = await prisma.preference.findUnique({ where: { userId } })
  if (!existing) return
  const current: string[] = JSON.parse(existing[type])
  await prisma.preference.update({
    where: { userId },
    data: { [type]: JSON.stringify(current.filter((v) => v !== value)) },
  })
}

const FREE_MONTHLY_LIMIT = 50 // increased for testing
const HOURLY_LIMIT = 50 // increased for testing

export async function checkActionLimit(
  userId: string
): Promise<{ allowed: boolean; plan: string; remaining: number; reason?: string }> {
  return prisma.$transaction(async (tx) => {
    let sub = await tx.subscription.findUnique({ where: { userId } })
    if (!sub) {
      sub = await tx.subscription.create({ data: { userId } })
    }

    const now = new Date()
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000)
    const monthStart = new Date(now)
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)

    // Normalize period windows inside the same transaction.
    if (sub.periodStart < monthStart || sub.lastHourStart < hourAgo) {
      sub = await tx.subscription.update({
        where: { userId },
        data: {
          ...(sub.periodStart < monthStart ? { messagesThisMonth: 0, periodStart: monthStart } : {}),
          ...(sub.lastHourStart < hourAgo ? { actionsThisHour: 0, lastHourStart: now } : {}),
        },
      })
    }

    if (sub.plan === "pro") {
      const updated = await tx.subscription.updateMany({
        where: {
          userId,
          actionsThisHour: { lt: HOURLY_LIMIT },
        },
        data: { actionsThisHour: { increment: 1 } },
      })

      if (updated.count === 0) {
        return { allowed: false, plan: "pro", remaining: 0, reason: "hourly" as const }
      }

      const after = await tx.subscription.findUnique({
        where: { userId },
        select: { actionsThisHour: true },
      })
      const remaining = Math.max(0, HOURLY_LIMIT - (after?.actionsThisHour ?? HOURLY_LIMIT))
      return { allowed: true, plan: "pro", remaining }
    }

    const updated = await tx.subscription.updateMany({
      where: {
        userId,
        messagesThisMonth: { lt: FREE_MONTHLY_LIMIT },
        actionsThisHour: { lt: HOURLY_LIMIT },
      },
      data: {
        messagesThisMonth: { increment: 1 },
        actionsThisHour: { increment: 1 },
      },
    })

    if (updated.count === 0) {
      const current = await tx.subscription.findUnique({
        where: { userId },
        select: { messagesThisMonth: true, actionsThisHour: true },
      })
      const reason = (current?.actionsThisHour ?? 0) >= HOURLY_LIMIT ? "hourly" : undefined
      return { allowed: false, plan: "free", remaining: 0, reason }
    }

    const after = await tx.subscription.findUnique({
      where: { userId },
      select: { messagesThisMonth: true },
    })
    const remaining = Math.max(0, FREE_MONTHLY_LIMIT - (after?.messagesThisMonth ?? FREE_MONTHLY_LIMIT))
    return { allowed: true, plan: "free", remaining }
  })
}

/** @deprecated Use checkActionLimit */
export async function checkMessageLimit(
  userId: string
): Promise<{ allowed: boolean; plan: string; remaining: number }> {
  return checkActionLimit(userId)
}
