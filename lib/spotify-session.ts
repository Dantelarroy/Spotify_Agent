import { prisma } from "./db"
import { encrypt, decrypt } from "./crypto"

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
    return JSON.parse(json)
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
  const session = await prisma.spotifySession.findUnique({ where: { userId } })
  return !!(session?.isValid)
}
