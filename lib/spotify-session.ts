import { prisma } from "./db"
import { encrypt, decrypt } from "./crypto"

type CookieLike = { name?: string; value?: string }

function hasRequiredSpotifyCookies(cookies: unknown): boolean {
  if (!Array.isArray(cookies)) return false
  const names = new Set(
    cookies
      .map((c) => (c && typeof c === "object" ? String((c as CookieLike).name || "") : ""))
      .filter(Boolean)
  )
  // sp_dc + sp_key is the minimum stable set for library actions (create playlist, add tracks).
  return names.has("sp_dc") && names.has("sp_key")
}

export async function saveSpotifySession(userId: string, cookies: object): Promise<void> {
  const cookieData = encrypt(JSON.stringify(cookies), userId)
  await prisma.spotifySession.upsert({
    where: { userId },
    create: { userId, cookieData },
    update: { cookieData, isValid: true, capturedAt: new Date() },
  })
}

export async function getSpotifySession(userId: string): Promise<object | null> {
  const session = await prisma.spotifySession.findUnique({ where: { userId } })
  if (!session || !session.isValid) return null
  try {
    const json = decrypt(session.cookieData, userId)
    const parsed = JSON.parse(json)
    if (!hasRequiredSpotifyCookies(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

export async function invalidateSpotifySession(userId: string): Promise<void> {
  await prisma.spotifySession.updateMany({
    where: { userId },
    data: { isValid: false },
  })
}

export async function hasSpotifySession(userId: string): Promise<boolean> {
  const session = await getSpotifySession(userId)
  return !!session
}
