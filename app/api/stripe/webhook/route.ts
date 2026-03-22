import { headers } from "next/headers"
import Stripe from "stripe"
import { prisma } from "@/lib/db"

export const runtime = "nodejs"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2026-02-25.clover",
})

export async function POST(req: Request) {
  const body = await req.text()
  const headersList = await headers()
  const sig = headersList.get("stripe-signature")

  if (!sig) {
    return new Response("Missing stripe-signature header", { status: 400 })
  }

  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    )
  } catch (err) {
    console.error("Stripe webhook error:", err)
    return new Response(`Webhook Error: ${(err as Error).message}`, {
      status: 400,
    })
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session
      const userId = session.metadata?.userId
      const customerId =
        typeof session.customer === "string" ? session.customer : null
      const subscriptionId =
        typeof session.subscription === "string" ? session.subscription : null

      if (userId) {
        await prisma.subscription.upsert({
          where: { userId },
          create: {
            userId,
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
            plan: "pro",
          },
          update: {
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
            plan: "pro",
          },
        })
      }
      break
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription
      const sub = await prisma.subscription.findFirst({
        where: { stripeSubscriptionId: subscription.id },
      })
      if (sub) {
        await prisma.subscription.update({
          where: { id: sub.id },
          data: { plan: "free" },
        })
      }
      break
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription
      const status = subscription.status
      const sub = await prisma.subscription.findFirst({
        where: { stripeSubscriptionId: subscription.id },
      })
      if (sub) {
        await prisma.subscription.update({
          where: { id: sub.id },
          data: { plan: status === "active" ? "pro" : "free" },
        })
      }
      break
    }

    default:
      break
  }

  return Response.json({ received: true })
}
