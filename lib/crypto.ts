import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto"

function deriveKey(userId: string): Buffer {
  const secret = process.env.AUTH_SECRET ?? "dev-secret-change-in-production"
  return scryptSync(`${secret}:${userId}`, "wavvy-session-salt", 32)
}

export function encrypt(plaintext: string, userId: string): string {
  const key = deriveKey(userId)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, encrypted]).toString("base64url")
}

export function decrypt(ciphertext: string, userId: string): string {
  const key = deriveKey(userId)
  const buf = Buffer.from(ciphertext, "base64url")
  const iv = buf.subarray(0, 12)
  const authTag = buf.subarray(12, 28)
  const encrypted = buf.subarray(28)
  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")
}
