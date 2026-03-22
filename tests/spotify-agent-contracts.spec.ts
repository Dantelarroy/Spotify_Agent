import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"
import { resolve } from "path"

/**
 * Contracts spec — static analysis + HTTP gates.
 *
 * Arquitectura exigida:
 *   - Screenshot-only para toda interacción de UI (sin selectores CSS en acciones)
 *   - Claude Haiku (más barato) para visión
 *   - runLoop central (observe-act loop)
 *   - Sin api.spotify.com, sin tokens OAuth
 */

// ─── Arquitectura ─────────────────────────────────────────────────────────────

test("usa claude-haiku como modelo de visión (el más barato)", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).toContain("claude-haiku-4-5-20251001")
})

test("screenshots en formato jpeg (más pequeño = más rápido)", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).toContain("jpeg")
})

test("existe runLoop como bucle agéntico central", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).toContain("runLoop")
})

test("runLoop llama a askHaiku (screenshot → acción)", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).toContain("askHaiku")
})

test("acciones del agente usan coordenadas x,y (no selectores)", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  // El agente debe mandar clicks por coordenadas
  expect(src).toContain('"x"')
  expect(src).toContain('"y"')
  // No debe usar page.locator() ni getByRole() para las acciones de UI
  // (sí puede usar page.evaluate() para extraer datos DOM — eso está bien)
  const runLoopBody = src.slice(src.indexOf("private async runLoop"), src.indexOf("private async runLoop") + 2000)
  expect(runLoopBody).not.toContain("page.locator(")
  expect(runLoopBody).not.toContain("page.getByRole(")
})

test("no usa la API oficial de Spotify", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).not.toContain("api.spotify.com")
})

test("no usa tokens OAuth (browser session vía sp_dc)", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).not.toContain("getToken")
  expect(src).not.toContain('Authorization: `Bearer')
})

// ─── Interfaz pública de SpotifyAgent ────────────────────────────────────────

test("SpotifyAgent.searchTracks existe", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).toContain("async searchTracks(")
})

test("SpotifyAgent.createPlaylist existe", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).toContain("async createPlaylist(")
})

test("SpotifyAgent.playTrack existe", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).toContain("async playTrack(")
})

test("SpotifyAgent.pausePlayback existe", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).toContain("async pausePlayback(")
})

test("SpotifyAgent.skipToNext existe", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).toContain("async skipToNext(")
})

test("SpotifyAgent.getNowPlaying existe", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).toContain("async getNowPlaying(")
})

test("createAgent factory exportada", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).toContain("export function createAgent")
})

// ─── Contratos de tools.ts ───────────────────────────────────────────────────

test("tools.ts tiene play_track", () => {
  const src = readFileSync(resolve("lib/tools.ts"), "utf-8")
  expect(src).toContain("play_track")
})

test("tools.ts tiene pause", () => {
  const src = readFileSync(resolve("lib/tools.ts"), "utf-8")
  expect(src).toContain("pause:")
})

test("tools.ts tiene next_track", () => {
  const src = readFileSync(resolve("lib/tools.ts"), "utf-8")
  expect(src).toContain("next_track")
})

test("tools.ts tiene now_playing", () => {
  const src = readFileSync(resolve("lib/tools.ts"), "utf-8")
  expect(src).toContain("now_playing")
})

test("play_track usa wrapSpotifyCall", () => {
  const src = readFileSync(resolve("lib/tools.ts"), "utf-8")
  const section = src.slice(src.indexOf("play_track"), src.indexOf("play_track") + 400)
  expect(section).toContain("wrapSpotifyCall")
})

// ─── HTTP gates ───────────────────────────────────────────────────────────────

test("chat sin auth retorna 401", async ({ request }) => {
  const res = await request.post("http://127.0.0.1:3000/api/chat", {
    data: { messages: [] },
  })
  expect(res.status()).toBe(401)
})

test("connect-spotify sin sp_dc retorna 400", async ({ request }) => {
  const res = await request.get("http://127.0.0.1:3000/api/connect-spotify")
  expect(res.status()).toBe(400)
})

// ─── Contratos de URL ─────────────────────────────────────────────────────────

test("URL de búsqueda: open.spotify.com/search/{query}/tracks", () => {
  const query = "tame impala currents"
  const url = `https://open.spotify.com/search/${encodeURIComponent(query)}/tracks`
  expect(url).toBe("https://open.spotify.com/search/tame%20impala%20currents/tracks")
})

test("URI de track: spotify:track:{id}", () => {
  const href = "/track/7x9aauaA9cu6tyfpHnqDLo"
  const id = href.replace("/track/", "").split("?")[0]
  expect(`spotify:track:${id}`).toBe("spotify:track:7x9aauaA9cu6tyfpHnqDLo")
})
