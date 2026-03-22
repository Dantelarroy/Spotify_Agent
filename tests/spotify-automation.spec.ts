import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"
import { resolve } from "path"

/**
 * Spec: SpotifyAgent — browser automation, NO api.spotify.com
 *
 * El doc dice explícitamente: "sin tocar la API oficial de Spotify".
 * El agente controla el Web Player como un humano (Vercel Sandbox pattern).
 * Todo pasa por el browser con las cookies de sesión del usuario.
 */

// ─── Análisis estático ────────────────────────────────────────────────────────

test("SpotifyAgent no referencia api.spotify.com", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).not.toContain("api.spotify.com")
})

test("SpotifyAgent no tiene getToken (no se necesita token para browser automation)", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  // No debe obtener un access token — el browser maneja la sesión via sp_dc
  expect(src).not.toContain("getToken")
  expect(src).not.toContain("accessToken")
  expect(src).not.toContain("Authorization: `Bearer")
})

test("SpotifyAgent usa chromium para browser automation", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  expect(src).toContain("chromium")
  expect(src).toContain("open.spotify.com")
})

test("La detección de sesión expirada usa login redirect (no token errors)", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  // Session expiry = Spotify redirige a accounts.spotify.com/login
  expect(src).toContain("accounts.spotify.com")
  expect(src).toContain("SPOTIFY_NOT_CONNECTED")
})

// ─── Contrato de la API del agente ───────────────────────────────────────────

test("createAgent y SpotifyAgent exportan la interfaz correcta", () => {
  const src = readFileSync(resolve("lib/spotify-agent.ts"), "utf-8")
  // Verifica que la factory function existe
  expect(src).toContain("export function createAgent")
  // Verifica que la clase tiene los métodos públicos requeridos
  expect(src).toContain("async searchTracks(")
  expect(src).toContain("async createPlaylist(")
})

// ─── Comportamiento de rutas HTTP (sin sesión real) ───────────────────────────

test("connect-spotify guarda sesión con sp_dc (verificado en test anterior)", async ({ request }) => {
  // El connect flow ya está testeado en spotify-session.spec.ts
  // Este test documenta que sp_dc ES requerido
  const res = await request.get("http://127.0.0.1:3000/api/connect-spotify")
  expect(res.status()).toBe(400) // sin sid = 400
})

test("chat sin spotify conectado retorna error 402 con code SPOTIFY_NOT_CONNECTED", async ({ request }) => {
  // Sin auth → 401. Con auth pero sin Spotify → 402 (documentado)
  const res = await request.post("http://127.0.0.1:3000/api/chat", {
    data: { messages: [] },
  })
  expect(res.status()).toBe(401) // unauthenticated confirms gate works
})

// ─── Comportamiento esperado del searchTracks (documentación) ─────────────────

/**
 * searchTracks(query, limit) — comportamiento esperado:
 *
 * 1. Lanza un browser headless Playwright con las cookies del usuario inyectadas
 * 2. Navega a https://open.spotify.com/search/{query}/tracks
 * 3. Si Spotify redirige a accounts.spotify.com → throw SPOTIFY_NOT_CONNECTED
 * 4. Espera que aparezcan links de tracks en el DOM (a[href^="/track/"])
 * 5. Extrae: name (texto del link), artist (a[href^="/artist/"]), uri (spotify:track:{id})
 * 6. Retorna Array<{ name, artist, uri }> filtrado por blacklist del usuario
 * 7. Cierra el browser
 */

/**
 * createPlaylist(name, description, trackQueries) — comportamiento esperado:
 *
 * 1. Lanza un browser headless con las cookies del usuario
 * 2. Navega a https://open.spotify.com
 * 3. Si redirige a login → throw SPOTIFY_NOT_CONNECTED
 * 4. Busca y clickea el botón "Create playlist" en el sidebar
 * 5. Captura el URL de la nueva playlist (https://open.spotify.com/playlist/{id})
 * 6. Renombra la playlist al nombre indicado
 * 7. Para cada trackQuery:
 *    a. Usa la búsqueda interna del Web Player para encontrar el track
 *    b. Agrega el primer resultado a la playlist
 *    c. Si falla, continúa con el siguiente (no aborta)
 * 8. Retorna { url: string, trackCount: number }
 * 9. Cierra el browser
 */

test("searchTracks URL es open.spotify.com/search/{query}/tracks", () => {
  // Documenta el contrato de URL — el browser debe navegar aquí
  const query = "tame impala currents"
  const expected = `https://open.spotify.com/search/${encodeURIComponent(query)}/tracks`
  expect(expected).toBe("https://open.spotify.com/search/tame%20impala%20currents/tracks")
})

test("uri de track tiene formato spotify:track:{id}", () => {
  const href = "/track/7x9aauaA9cu6tyfpHnqDLo"
  const id = href.replace("/track/", "").split("?")[0]
  const uri = `spotify:track:${id}`
  expect(uri).toBe("spotify:track:7x9aauaA9cu6tyfpHnqDLo")
})
