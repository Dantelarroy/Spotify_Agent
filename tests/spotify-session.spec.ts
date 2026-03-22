import { test, expect } from "@playwright/test"

// Tests for Spotify session management — spec-driven for the sp_dc capture & token flow

test("GET /api/connect-spotify sin sid retorna 400", async ({ request }) => {
  const res = await request.get("http://127.0.0.1:3000/api/connect-spotify")
  expect(res.status()).toBe(400)
})

test("GET /api/connect-spotify con sid desconocido retorna error o connected (no crash)", async ({ request }) => {
  const res = await request.get(
    "http://127.0.0.1:3000/api/connect-spotify?sid=fake-session-id-that-does-not-exist"
  )
  // Should return 200 with error/connected status — not a 500
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.status).toMatch(/^(error|connected)$/)
})

test("POST /api/connect-spotify sin auth retorna 401", async ({ request }) => {
  const res = await request.post("http://127.0.0.1:3000/api/connect-spotify")
  expect(res.status()).toBe(401)
})

test("GET /api/spotify-status sin auth retorna connected:false (no crash)", async ({ request }) => {
  const res = await request.get("http://127.0.0.1:3000/api/spotify-status")
  // Returns 200 with connected:false — intentional (sidebar polls this without auth check)
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.connected).toBe(false)
})

test("GET /api/chat sin auth retorna 401", async ({ request }) => {
  const res = await request.post("http://127.0.0.1:3000/api/chat", {
    data: { messages: [] },
  })
  expect(res.status()).toBe(401)
})

// Validates that the sp_dc token endpoint rejects requests without a valid sp_dc
// (smoke test — confirms endpoint URL and error behavior)
test("open.spotify.com/api/token sin sp_dc retorna error (no 200)", async ({ request }) => {
  const res = await request.get("https://open.spotify.com/api/token", {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  })
  // Without sp_dc, Spotify returns a 4xx error — not a valid token
  // This confirms that sp_dc is strictly required (our getToken() must throw SPOTIFY_NOT_CONNECTED)
  expect(res.status()).toBeGreaterThanOrEqual(400)
})
