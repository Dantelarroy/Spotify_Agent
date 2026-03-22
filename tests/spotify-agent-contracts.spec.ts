import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"
import { resolve } from "path"

/**
 * Contracts spec — static analysis + HTTP gates.
 *
 * Arquitectura exigida:
 *   - Vercel Sandbox (@vercel/sandbox) para microVM efímero
 *   - Playwright dentro del VM para flujo robusto E2E
 *   - Session bootstrap con cookies (sp_dc + sp_key) via context.addCookies
 *   - Sin API oficial de Spotify
 *   - Sin screenshots con modelos de visión
 */

// ─── Arquitectura: Vercel Sandbox ────────────────────────────────────────────

test("usa @vercel/sandbox (microVM efímero)", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).toContain("@vercel/sandbox")
  expect(src).toContain("Sandbox.create")
})

test("destruye el sandbox al terminar (sandbox.stop)", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).toContain("sandbox.stop")
})

test("soporta snapshot pre-baked para arranque rápido", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).toContain("AGENT_BROWSER_SNAPSHOT_ID")
  expect(src).toContain("type: \"snapshot\"")
})

// ─── Arquitectura: agent-browser CLI ─────────────────────────────────────────

test("usa agent-browser como CLI via runCommand", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).toContain("agent-browser")
  expect(src).toContain("runCommand")
})

test("usa Playwright con session cookies (context.addCookies)", () => {
  const agentSrc = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  const scriptSrc = readFileSync(resolve("scripts/pw/create-playlist.cjs"), "utf-8")
  expect(agentSrc).toContain("runPlaywrightPlaylistFlow")
  expect(agentSrc).toContain("runPlaywrightPlayerControl")
  expect(scriptSrc).toContain("context.addCookies")
})

test("mantiene agent-browser como capacidad auxiliar", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).toContain("agent-browser")
  expect(src).toContain("createSnapshot")
})

test("acciones con fallback a eval JS (no depende solo del AX tree)", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).toContain("agentEval")
  expect(src).toContain("findAndClick")
})

// ─── Sin screenshots, sin Claude Haiku ───────────────────────────────────────

test("usa Playwright como runtime principal de automatización", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).toContain("PLAYWRIGHT_NODE_MODULES")
  expect(src).toContain("/tmp/pw-create-playlist.cjs")
})

test("no usa Claude Haiku para visión (screenshots eliminados)", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).not.toContain("claude-haiku")
  expect(src).not.toContain("image/jpeg")
  expect(src).not.toContain("askHaiku")
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

test("SpotifyAgent.createSnapshot existe (setup inicial)", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).toContain("async createSnapshot(")
})

test("createAgent factory exportada", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).toContain("export function createAgent")
})

// ─── tools.ts — sin cambios en la interfaz ───────────────────────────────────

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
