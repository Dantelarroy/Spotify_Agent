import { test, expect } from "@playwright/test"
import { encrypt, decrypt } from "../../lib/crypto"

const userId = "test-user-123"
const data = JSON.stringify([{ name: "sp_t", value: "abc123", domain: ".spotify.com", path: "/" }])

test("encrypt returns base64url string", () => {
  const encrypted = encrypt(data, userId)
  expect(typeof encrypted).toBe("string")
  expect(encrypted).not.toBe(data)
})

test("decrypt recovers original data", () => {
  const encrypted = encrypt(data, userId)
  const decrypted = decrypt(encrypted, userId)
  expect(decrypted).toBe(data)
})

test("different users produce different ciphertext", () => {
  const enc1 = encrypt(data, "user-1")
  const enc2 = encrypt(data, "user-2")
  expect(enc1).not.toBe(enc2)
})

test("different encryptions of same data differ (random IV)", () => {
  const enc1 = encrypt(data, userId)
  const enc2 = encrypt(data, userId)
  expect(enc1).not.toBe(enc2)
})

test("decrypt with wrong userId throws", () => {
  const encrypted = encrypt(data, userId)
  expect(() => decrypt(encrypted, "wrong-user")).toThrow()
})
