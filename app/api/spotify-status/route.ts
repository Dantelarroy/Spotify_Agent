import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { hasSpotifySession } from "@/lib/spotify-session"

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ connected: false })
  }
  const connected = await hasSpotifySession(session.user.id)
  return NextResponse.json({ connected })
}
