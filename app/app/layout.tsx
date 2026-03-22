import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { SidebarClient } from "@/components/sidebar-client"

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth()
  if (!session?.user) {
    redirect("/")
  }

  const userId = session.user.id
  if (!userId) {
    redirect("/")
  }

  // Load preferences, subscription and spotify status for sidebar
  const [prefs, sub, spotifySession] = await Promise.all([
    prisma.preference.findUnique({ where: { userId } }),
    prisma.subscription.findUnique({ where: { userId } }),
    prisma.spotifySession.findUnique({ where: { userId } }),
  ])

  const blacklist: string[] = prefs ? JSON.parse(prefs.blacklist) : []
  const whitelist: string[] = prefs ? JSON.parse(prefs.whitelist) : []

  return (
    <div className="flex h-screen overflow-hidden bg-[#0a0a0a]">
      <SidebarClient
        user={{
          name: session.user.name ?? null,
          email: session.user.email ?? null,
          image: session.user.image ?? null,
        }}
        plan={sub?.plan ?? "free"}
        blacklist={blacklist}
        whitelist={whitelist}
        spotifyConnected={!!(spotifySession?.isValid)}
      />
      <main className="flex-1 overflow-hidden flex flex-col">{children}</main>
    </div>
  )
}
