import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"

export const runtime = "nodejs"

type ResetBody = {
  userId?: string
  email?: string
  resetMonthly?: boolean
  resetHourly?: boolean
  setPlan?: "free" | "pro"
}

export async function POST(req: NextRequest) {
  const session = await auth()

  let body: ResetBody = {}
  try {
    body = (await req.json()) as ResetBody
  } catch {
    body = {}
  }

  const callerUserId = session?.user?.id ?? ""
  const requestedUserId = (body.userId || "").trim()

  const resetMonthly = body.resetMonthly !== false
  const resetHourly = body.resetHourly !== false
  const setPlan = body.setPlan

  const adminKey = req.headers.get("x-admin-key") || ""
  const expectedAdminKey = process.env.ADMIN_API_KEY || ""
  const hasValidAdminKey = Boolean(expectedAdminKey) && adminKey === expectedAdminKey
  const isProduction = process.env.VERCEL === "1" || process.env.NODE_ENV === "production"

  // In production this endpoint is admin-only.
  if (isProduction && !hasValidAdminKey) {
    return NextResponse.json({ error: "Forbidden (admin key required)" }, { status: 403 })
  }

  if (!isProduction && !callerUserId && !hasValidAdminKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let targetUserId = requestedUserId || callerUserId
  const requestedEmail = (body.email || "").trim()
  if (!targetUserId && requestedEmail) {
    const user = await prisma.user.findUnique({
      where: { email: requestedEmail },
      select: { id: true },
    })
    targetUserId = user?.id ?? ""
  }

  if (!targetUserId) {
    return NextResponse.json(
      { error: "Missing target user. Provide userId or email, or authenticate your session." },
      { status: 400 }
    )
  }

  const isAdminCall = targetUserId !== callerUserId || Boolean(setPlan) || !callerUserId

  if (!isProduction && isAdminCall) {
    if (!hasValidAdminKey) {
      return NextResponse.json({ error: "Forbidden (admin key required)" }, { status: 403 })
    }
  }

  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)

  const updateData: {
    messagesThisMonth?: number
    periodStart?: Date
    actionsThisHour?: number
    lastHourStart?: Date
    plan?: "free" | "pro"
  } = {}

  if (resetMonthly) {
    updateData.messagesThisMonth = 0
    updateData.periodStart = monthStart
  }
  if (resetHourly) {
    updateData.actionsThisHour = 0
    updateData.lastHourStart = new Date()
  }
  if (setPlan === "free" || setPlan === "pro") {
    updateData.plan = setPlan
  }

  const sub = await prisma.subscription.upsert({
    where: { userId: targetUserId },
    create: {
      userId: targetUserId,
      plan: updateData.plan ?? "free",
      messagesThisMonth: updateData.messagesThisMonth ?? 0,
      periodStart: updateData.periodStart ?? monthStart,
      actionsThisHour: updateData.actionsThisHour ?? 0,
      lastHourStart: updateData.lastHourStart ?? new Date(),
    },
    update: updateData,
    select: {
      userId: true,
      plan: true,
      messagesThisMonth: true,
      actionsThisHour: true,
      periodStart: true,
      lastHourStart: true,
    },
  })

  return NextResponse.json({
    ok: true,
    reset: {
      resetMonthly,
      resetHourly,
      setPlan: setPlan ?? null,
    },
    subscription: sub,
  })
}
