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
  let sub = await prisma.subscription.findUnique({ where: { userId } })
  if (!sub) {
    sub = await prisma.subscription.create({ data: { userId } })
  }

  // Pro users: only hourly rate limit applies
  if (sub.plan === "pro") {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
    if (sub.lastHourStart < hourAgo) {
      sub = await prisma.subscription.update({
        where: { userId },
        data: { actionsThisHour: 0, lastHourStart: new Date() },
      })
    }
    if (sub.actionsThisHour >= HOURLY_LIMIT) {
      return { allowed: false, plan: "pro", remaining: 0, reason: "hourly" }
    }
    await prisma.subscription.update({
      where: { userId },
      data: { actionsThisHour: { increment: 1 } },
    })
    return { allowed: true, plan: "pro", remaining: HOURLY_LIMIT - sub.actionsThisHour - 1 }
  }

  // Free users: monthly limit + hourly rate limit
  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)

  if (sub.periodStart < monthStart) {
    sub = await prisma.subscription.update({
      where: { userId },
      data: { messagesThisMonth: 0, periodStart: monthStart },
    })
  }

  if (sub.messagesThisMonth >= FREE_MONTHLY_LIMIT) {
    return { allowed: false, plan: "free", remaining: 0 }
  }

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
  if (sub.lastHourStart < hourAgo) {
    sub = await prisma.subscription.update({
      where: { userId },
      data: { actionsThisHour: 0, lastHourStart: new Date() },
    })
  }

  if (sub.actionsThisHour >= HOURLY_LIMIT) {
    return { allowed: false, plan: "free", remaining: 0, reason: "hourly" }
  }

  await prisma.subscription.update({
    where: { userId },
    data: { messagesThisMonth: { increment: 1 }, actionsThisHour: { increment: 1 } },
  })
  return { allowed: true, plan: "free", remaining: FREE_MONTHLY_LIMIT - sub.messagesThisMonth - 1 }
}

/** @deprecated Use checkActionLimit */
export async function checkMessageLimit(
  userId: string
): Promise<{ allowed: boolean; plan: string; remaining: number }> {
  return checkActionLimit(userId)
}
