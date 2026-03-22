import { test, expect } from "@playwright/test"

test("/api/interpret retorna tracks para texto en español", async ({ request }) => {
  const res = await request.post("http://127.0.0.1:3000/api/interpret", {
    data: { text: "Salgo de surfear, poneme algo con energía pero relajado" },
  })
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.tracks).toBeDefined()
  expect(body.detectedMood).toBeDefined()
  expect(Array.isArray(body.tracks)).toBe(true)
})

test("/api/interpret requiere campo text", async ({ request }) => {
  const res = await request.post("http://127.0.0.1:3000/api/interpret", {
    data: {},
  })
  expect(res.status()).toBe(400)
})

test("/api/chat retorna 401 sin auth", async ({ request }) => {
  const res = await request.post("http://127.0.0.1:3000/api/chat", {
    data: { messages: [] },
  })
  expect(res.status()).toBe(401)
})
