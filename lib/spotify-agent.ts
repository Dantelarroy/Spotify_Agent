/**
 * SpotifyAgent — browser automation via Playwright + Claude Haiku vision.
 *
 * Arquitectura: screenshot-only observe-act loop.
 *   1. Tomar screenshot JPEG del browser (1280×800)
 *   2. Enviar a Claude Haiku (modelo de visión más barato)
 *   3. Haiku devuelve UNA acción con coordenadas (x, y) o texto
 *   4. Playwright ejecuta la acción
 *   5. Repetir hasta que la condición de éxito se cumpla
 *
 * Sin selectores CSS hardcodeados para acciones de UI.
 * Funciona aunque Spotify cambie su DOM o diseño.
 *
 * NO usa la API oficial de Spotify. Todo pasa por el browser con cookies (sp_dc).
 */

import { chromium, type Browser, type Page } from "playwright"
import Anthropic from "@anthropic-ai/sdk"

export interface SpotifyAgentCookie {
  name: string
  value: string
  domain: string
  path: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: "Strict" | "Lax" | "None"
}

// Modelo más barato con visión — $0.80/MTok input, $4/MTok output
const VISION_MODEL = "claude-haiku-4-5-20251001"

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

type AgentAction =
  | { action: "click"; x: number; y: number; reason: string }
  | { action: "type"; text: string; reason: string }
  | { action: "key"; key: string; reason: string }
  | { action: "scroll"; dir: "up" | "down"; reason: string }
  | { action: "done"; result: string; reason: string }
  | { action: "failed"; reason: string }

function buildPrompt(goal: string, step: number, maxSteps: number): string {
  return `You control Spotify Web Player running in a headless browser at 1280×800 pixels.

GOAL: ${goal}
STEP: ${step + 1} of ${maxSteps}

Look at the screenshot carefully and choose exactly ONE action to take right now.
Reply with ONLY a single JSON object — no markdown, no explanation.

{"action":"click","x":NNN,"y":NNN,"reason":"why you click here"}
{"action":"type","text":"the text to type","reason":"..."}
{"action":"key","key":"Enter","reason":"..."}
{"action":"scroll","dir":"down","reason":"..."}
{"action":"done","result":"description of what was achieved","reason":"..."}
{"action":"failed","reason":"SPOTIFY_NOT_CONNECTED"}

Rules:
- PRIORITY 1: If a cookie/GDPR consent banner is blocking the UI, click Accept or Reject first.
- Click (x,y) must be the center of the visible element you want to interact with.
- To type into a field: first click the field (step N), then type the text (step N+1).
- If Spotify shows the login page at accounts.spotify.com → {"action":"failed","reason":"SPOTIFY_NOT_CONNECTED"}.
- Only return "done" when the GOAL is fully achieved.`
}

export class SpotifyAgent {
  private cookies: SpotifyAgentCookie[]

  constructor(cookies: SpotifyAgentCookie[]) {
    this.cookies = cookies
  }

  private async withBrowser<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    let browser: Browser | null = null
    try {
      browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      })
      const ctx = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        locale: "en-US",
        viewport: { width: 1280, height: 800 },
      })
      await ctx.addCookies(this.cookies)
      const page = await ctx.newPage()
      return await fn(page)
    } finally {
      await browser?.close().catch(() => {})
    }
  }

  private assertNotLoginPage(url: string): void {
    if (url.includes("accounts.spotify.com")) {
      throw new Error(
        "SPOTIFY_NOT_CONNECTED: Spotify redirected to login. Session expired — please reconnect."
      )
    }
  }

  /** Toma un screenshot JPEG comprimido y lo devuelve en base64. */
  private async screenshot(page: Page, label?: string): Promise<string> {
    const buf = await page.screenshot({ type: "jpeg", quality: 80 })
    if (label) {
      await page.screenshot({ path: `/tmp/spotify-${label}.jpg` }).catch(() => {})
    }
    return buf.toString("base64")
  }

  /** Envía el screenshot a Claude Haiku y parsea la acción JSON resultante. */
  private async askHaiku(
    image: string,
    goal: string,
    step: number,
    maxSteps: number
  ): Promise<AgentAction> {
    const response = await anthropic.messages.create({
      model: VISION_MODEL,
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: image },
            },
            {
              type: "text",
              text: buildPrompt(goal, step, maxSteps),
            },
          ],
        },
      ],
    })

    const text =
      response.content[0].type === "text" ? response.content[0].text.trim() : ""
    const match = text.match(/\{[\s\S]*?\}/)

    if (!match) {
      console.log(`[agent] step ${step}: no JSON from Haiku — "${text.slice(0, 100)}"`)
      return { action: "failed", reason: "Haiku returned no valid JSON" }
    }

    try {
      return JSON.parse(match[0]) as AgentAction
    } catch {
      return { action: "failed", reason: "JSON parse error" }
    }
  }

  /** Ejecuta una acción de Playwright a partir de la decisión de Haiku. */
  private async executeAction(page: Page, action: AgentAction): Promise<void> {
    if (action.action === "click") {
      await page.mouse.click(action.x, action.y)
    } else if (action.action === "type") {
      await page.keyboard.type(action.text, { delay: 40 })
    } else if (action.action === "key") {
      await page.keyboard.press(action.key)
    } else if (action.action === "scroll") {
      await page.mouse.wheel(0, action.dir === "down" ? 300 : -300)
    }
  }

  /**
   * Bucle agéntico central: screenshot → Haiku decide → ejecuta → verifica.
   *
   * successCheck: función DOM barata que devuelve string si el goal se cumplió, null si no.
   * Haiku también puede declarar "done" por sí mismo al ver el resultado en pantalla.
   */
  private async runLoop(
    page: Page,
    goal: string,
    successCheck: (page: Page) => Promise<string | null>,
    maxSteps = 12
  ): Promise<string> {
    for (let step = 0; step < maxSteps; step++) {
      // Verificar URL primero (más barato que screenshot)
      this.assertNotLoginPage(page.url())

      // Verificar condición de éxito via DOM (sin imagen, muy barato)
      const domResult = await successCheck(page)
      if (domResult !== null) {
        console.log(`[agent] ✓ dom-check at step ${step}: ${domResult}`)
        return domResult
      }

      // Screenshot + Haiku
      const img = await this.screenshot(page, `step-${step}`)
      const action = await this.askHaiku(img, goal, step, maxSteps)

      const coords =
        action.action === "click"
          ? ` (${action.x},${action.y})`
          : action.action === "type"
          ? ` "${action.text}"`
          : ""
      console.log(`[agent] step ${step}: ${action.action}${coords} — ${action.reason}`)

      if (action.action === "done") return action.result

      if (action.action === "failed") {
        const msg = action.reason
        throw new Error(
          msg.includes("SPOTIFY_NOT_CONNECTED")
            ? msg
            : `Agent failed: ${msg}`
        )
      }

      await this.executeAction(page, action)
      await page.waitForTimeout(600) // dejar que la UI reaccione
    }

    throw new Error(`Agent loop exhausted after ${maxSteps} steps for goal: ${goal.slice(0, 60)}`)
  }

  // ─── Métodos públicos ──────────────────────────────────────────────────────

  /**
   * Busca tracks — extracción DOM pura, sin visión.
   * No necesita IA porque los datos están en atributos href estructurados.
   */
  async searchTracks(
    query: string,
    limit = 10
  ): Promise<Array<{ name: string; artist: string; uri: string }>> {
    return this.withBrowser(async (page) => {
      await page.goto(
        `https://open.spotify.com/search/${encodeURIComponent(query)}/tracks`,
        { waitUntil: "domcontentloaded", timeout: 20000 }
      )
      this.assertNotLoginPage(page.url())
      await page.waitForSelector('a[href^="/track/"]', { timeout: 15000 }).catch(() => {})

      const tracks = await page.evaluate((lim: number) => {
        const seen = new Set<string>()
        const results: Array<{ name: string; artist: string; uri: string }> = []

        for (const link of Array.from(document.querySelectorAll('a[href^="/track/"]'))) {
          const href = (link as HTMLAnchorElement).getAttribute("href") ?? ""
          const id = href.replace("/track/", "").split("?")[0].trim()
          if (!id || seen.has(id)) continue
          seen.add(id)

          const name = link.textContent?.trim() ?? ""
          if (!name) continue

          const row =
            link.closest('[data-testid="tracklist-row"]') ??
            link.closest('[role="row"]') ??
            link.parentElement?.parentElement?.parentElement
          const artist =
            row?.querySelector('a[href^="/artist/"]')?.textContent?.trim() ?? ""

          results.push({ name, artist, uri: `spotify:track:${id}` })
          if (results.length >= lim) break
        }
        return results
      }, limit)

      return tracks.filter((t) => t.name && t.uri.startsWith("spotify:track:"))
    })
  }

  /**
   * Crea una playlist y agrega tracks.
   * Toda la interacción UI se hace via screenshot + Haiku.
   */
  async createPlaylist(
    name: string,
    description: string,
    trackQueries: string[]
  ): Promise<{ url: string; trackCount: number }> {
    return this.withBrowser(async (page) => {
      console.log("[spotify-agent] navigating to open.spotify.com")
      await page.goto("https://open.spotify.com", {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      })
      this.assertNotLoginPage(page.url())
      await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {})
      await page.waitForTimeout(1500)

      // ── PASO 1: Crear playlist vacía ───────────────────────────────────────
      const playlistUrl = await this.runLoop(
        page,
        `Create a new empty Spotify playlist:
1. If a cookie/GDPR consent banner is visible, dismiss it first (click Accept or Reject).
2. In the LEFT SIDEBAR, find the "+" button or "Create playlist" button near "Your Library" and click it.
3. If a dropdown appears with options like "Playlist", "Blend", "Folder" — click "Playlist".
4. Wait for the page to navigate to a new playlist URL that contains /playlist/.
5. Once on the playlist page, return done with the current page URL as result.`,
        async (p) => {
          const id = p.url().split("/playlist/")[1]?.split("?")[0]
          return id ? p.url() : null
        }
      )

      const playlistId = playlistUrl.split("/playlist/")[1]?.split("?")[0]
      if (!playlistId) throw new Error("Could not extract playlist ID")
      const canonicalUrl = `https://open.spotify.com/playlist/${playlistId}`
      console.log("[spotify-agent] playlist created:", canonicalUrl)

      // ── PASO 2: Renombrar la playlist ───────────────────────────────────────
      console.log("[spotify-agent] renaming to:", name)
      await this.runLoop(
        page,
        `Rename this Spotify playlist to exactly: "${name}"
1. Find the editable playlist title on screen (usually shows "My Playlist #N") or find an "Edit details" pencil icon and click it.
2. If a modal/dialog opens with a name input field, click inside the field.
3. Select all existing text in the field (Ctrl+A or triple-click) and delete it.
4. Type the new name: ${name}
5. Click the Save button or press Enter to confirm.
6. Return done once the name has been saved.`,
        async (p) => {
          // Verificar si el título del documento o h1 cambió
          const title = await p.evaluate(() => {
            const el =
              document.querySelector('[data-testid="playlist-title"]') ??
              document.querySelector('h1')
            return el?.textContent?.trim() ?? ""
          })
          return title === name ? "renamed" : null
        },
        10
      ).catch((e) =>
        console.log("[spotify-agent] rename failed (continuing):", String(e).slice(0, 80))
      )

      // ── PASO 3: Agregar tracks ──────────────────────────────────────────────
      console.log("[spotify-agent] adding", trackQueries.length, "tracks")
      let trackCount = 0
      for (const query of trackQueries.slice(0, 15)) {
        try {
          const added = await this.addOneTrack(page, query, name)
          if (added) trackCount++
        } catch (e) {
          console.log("[spotify-agent] track failed:", query, String(e).slice(0, 60))
        }
      }

      console.log("[spotify-agent] done. tracks:", trackCount)
      return { url: canonicalUrl, trackCount }
    })
  }

  /**
   * Agrega UN track a la playlist via screenshot agent.
   * Flujo: hover row → click ⋯ → click "Add to playlist" → click playlist name.
   */
  private async addOneTrack(
    page: Page,
    query: string,
    playlistName: string
  ): Promise<boolean> {
    await page.goto(
      `https://open.spotify.com/search/${encodeURIComponent(query)}/tracks`,
      { waitUntil: "domcontentloaded", timeout: 15000 }
    )
    await page.waitForSelector('a[href^="/track/"]', { timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(800)

    try {
      await this.runLoop(
        page,
        `Add the FIRST track from these search results to a playlist named "${playlistName}":
1. Look at the FIRST track row in the results list. Move mouse over it to reveal hidden buttons.
2. Click the three-dots (⋯) "More options" button that appears on the right side of the FIRST track row when hovered.
3. When a context menu pops up, click the "Add to playlist" option.
4. When a sub-menu or popover appears showing a list of playlists, find and click "${playlistName}".
5. Return done when you have clicked the playlist name or see a confirmation toast.`,
        async () => null,
        8
      )
      return true
    } catch {
      return false
    }
  }

  /**
   * Busca un track y lo pone a reproducir en el Web Player.
   * Inicializa el Web Player navegando a la homepage primero.
   */
  async playTrack(query: string): Promise<{ name: string; artist: string }> {
    return this.withBrowser(async (page) => {
      // Inicializar el Web Player (necesario para que sea el dispositivo activo)
      await page.goto("https://open.spotify.com", {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      })
      this.assertNotLoginPage(page.url())
      await page.waitForTimeout(2000)

      // Navegar a resultados de búsqueda
      await page.goto(
        `https://open.spotify.com/search/${encodeURIComponent(query)}/tracks`,
        { waitUntil: "domcontentloaded", timeout: 15000 }
      )
      this.assertNotLoginPage(page.url())
      await page.waitForSelector('a[href^="/track/"]', { timeout: 8000 }).catch(() => {})
      await page.waitForTimeout(800)

      // Extraer info del primer track (DOM, sin IA)
      const trackInfo = await page.evaluate(() => {
        const row = document.querySelector('[data-testid="tracklist-row"]')
        if (!row) return { name: "", artist: "" }
        return {
          name: row.querySelector('a[href^="/track/"]')?.textContent?.trim() ?? "",
          artist: row.querySelector('a[href^="/artist/"]')?.textContent?.trim() ?? "",
        }
      })

      await this.runLoop(
        page,
        `Play the FIRST track in the search results:
1. Look at the first track row. Hover over it to reveal the green play button (▶).
2. Click the green play/triangle button on the FIRST track row.
3. Return done when you've clicked the play button or when the bottom player bar shows a track playing.`,
        async (p) => {
          const playing = await p.evaluate(() =>
            document.querySelector('[data-testid="context-item-link"]')?.textContent?.trim() ?? null
          )
          return playing ? `playing:${playing}` : null
        },
        6
      ).catch(() => {})

      console.log("[spotify-agent] playTrack:", trackInfo.name, "-", trackInfo.artist)
      return { name: trackInfo.name || query, artist: trackInfo.artist }
    })
  }

  /**
   * Pausa o reanuda la reproducción.
   * Encuentra el botón play/pause en la barra inferior via screenshot.
   */
  async pausePlayback(): Promise<void> {
    return this.withBrowser(async (page) => {
      await page.goto("https://open.spotify.com", {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      })
      this.assertNotLoginPage(page.url())
      await page.waitForTimeout(2500)

      await this.runLoop(
        page,
        `Toggle play/pause in the Spotify player bar at the BOTTOM of the screen:
1. Find the large circular play/pause button in the CENTER of the bottom player bar.
2. Click it once.
3. Return done immediately after clicking it.`,
        async () => null,
        4
      ).catch((e) =>
        console.log("[spotify-agent] pausePlayback failed:", String(e).slice(0, 80))
      )
    })
  }

  /**
   * Salta a la siguiente canción.
   * Encuentra el botón skip-forward en la barra inferior via screenshot.
   */
  async skipToNext(): Promise<void> {
    return this.withBrowser(async (page) => {
      await page.goto("https://open.spotify.com", {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      })
      this.assertNotLoginPage(page.url())
      await page.waitForTimeout(2500)

      await this.runLoop(
        page,
        `Skip to the next track using the bottom player bar:
1. Find the skip-to-next button (⏭ forward arrows / double chevron pointing right) in the bottom bar, to the RIGHT of the play/pause button.
2. Click it once.
3. Return done immediately after clicking it.`,
        async () => null,
        4
      ).catch((e) =>
        console.log("[spotify-agent] skipToNext failed:", String(e).slice(0, 80))
      )
    })
  }

  /**
   * Lee qué está sonando actualmente — extracción DOM, sin visión.
   */
  async getNowPlaying(): Promise<{ name: string; artist: string } | null> {
    return this.withBrowser(async (page) => {
      await page.goto("https://open.spotify.com", {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      })
      this.assertNotLoginPage(page.url())
      await page.waitForTimeout(2500)

      return page.evaluate(() => {
        const track = document
          .querySelector('[data-testid="context-item-link"]')
          ?.textContent?.trim()
        const artist = document
          .querySelector('[data-testid="context-item-info-artist"]')
          ?.textContent?.trim()
        if (!track) return null
        return { name: track, artist: artist ?? "" }
      })
    })
  }
}

export function createAgent(storedCookies: object): SpotifyAgent {
  return new SpotifyAgent(storedCookies as SpotifyAgentCookie[])
}
