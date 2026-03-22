/**
 * SpotifyAgent — Vercel Sandbox + agent-browser (Rust/CDP).
 *
 * Arquitectura:
 * 1. @vercel/sandbox crea un microVM Firecracker efímero
 * 2. agent-browser (CLI Rust) controla Chrome via CDP dentro del VM
 * 3. Las cookies de sesión del usuario se inyectan via CDP (Network.setCookies)
 * 4. Acciones: AX tree snapshot → click @ref, con fallback a eval JS
 * 5. Al terminar, el VM se destruye — sin estado residual
 *
 * Sin screenshots, sin Claude Haiku vision, sin Playwright.
 * NO usa la API oficial de Spotify.
 *
 * Costo objetivo: ~$0.0008 por 15s de CPU (Vercel Fluid Compute).
 * Latencia objetivo: ~15s para playlists simples (con snapshot pre-baked).
 *
 * Setup inicial (una sola vez):
 *   const agent = createAgent(cookies)
 *   const snapshotId = await agent.createSnapshot()
 *   // Guardar snapshotId en AGENT_BROWSER_SNAPSHOT_ID
 */

import { Sandbox } from "@vercel/sandbox"

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

// ─── CDP cookie injection script ──────────────────────────────────────────────
// Corre dentro del microVM (Node 24 — WebSocket built-in, top-level await en .mjs)
const INJECT_COOKIES_MJS = `
import http from 'node:http';
import { readFileSync } from 'node:fs';

const cookies = JSON.parse(readFileSync('/root/cookies.json', 'utf8'));

const targets = await new Promise((ok, fail) => {
  http.get('http://localhost:9222/json', (res) => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => ok(JSON.parse(d))); res.on('error', fail);
  });
});

const page = targets.find(t => t.type === 'page') ?? targets[0];
if (!page?.webSocketDebuggerUrl) { console.error('no CDP target'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let done = false;

ws.addEventListener('open', () =>
  ws.send(JSON.stringify({ id: 1, method: 'Network.enable' }))
);
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id === 1) {
    ws.send(JSON.stringify({ id: 2, method: 'Network.setCookies', params: { cookies } }));
  } else if (m.id === 2) {
    done = true; ws.close(); process.exit(0);
  }
});
ws.addEventListener('error', ev => { console.error('CDP error', ev.message); process.exit(1); });
setTimeout(() => { if (!done) { console.error('timeout'); process.exit(1); } }, 8000);
`.trim()

// Dependencias del sistema para Chromium en Fedora (runtime Vercel Sandbox)
const CHROMIUM_DEPS = [
  "nss", "nspr", "libxkbcommon", "atk", "at-spi2-atk", "at-spi2-core",
  "libXcomposite", "libXdamage", "libXrandr", "libXfixes", "libXcursor",
  "libXi", "libXtst", "libXScrnSaver", "libXext", "mesa-libgbm", "libdrm",
  "mesa-libGL", "mesa-libEGL", "cups-libs", "alsa-lib", "pango", "cairo",
  "gtk3", "dbus-libs",
]

interface AXElement {
  ref: string   // e.g. "e5"
  role: string  // e.g. "button"
  name: string  // e.g. "Create playlist"
}

export class SpotifyAgent {
  private cookies: SpotifyAgentCookie[]

  constructor(cookies: SpotifyAgentCookie[]) {
    this.cookies = cookies
  }

  private describeSandboxError(err: unknown): string {
    if (!err || typeof err !== "object") {
      return String(err)
    }
    const e = err as {
      message?: string
      response?: { status?: number; statusText?: string; url?: string }
      json?: unknown
      text?: string
      sandboxId?: string
    }
    const parts = [
      e.message ?? "unknown sandbox error",
      e.response?.status ? `status=${e.response.status}` : "",
      e.response?.url ? `url=${e.response.url}` : "",
      e.sandboxId ? `sandboxId=${e.sandboxId}` : "",
      e.text ? `text=${String(e.text).slice(0, 240)}` : "",
      e.json ? `json=${JSON.stringify(e.json).slice(0, 240)}` : "",
    ].filter(Boolean)
    return parts.join(" | ")
  }

  private isRetryableSandboxError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("Status code 400 is not ok")) return true
    if (msg.includes("Status code 429 is not ok")) return true
    if (msg.includes("Status code 500 is not ok")) return true
    return false
  }

  private async runSandboxCommand(
    sandbox: Sandbox,
    label: string,
    cmd: string,
    args: string[],
    retries = 1
  ) {
    let lastErr: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await sandbox.runCommand(cmd, args)
      } catch (err) {
        lastErr = err
        const detail = this.describeSandboxError(err)
        console.error(
          `[sandbox][${label}] command failed (attempt ${attempt + 1}/${retries + 1}):`,
          detail
        )
        if (attempt < retries && this.isRetryableSandboxError(err)) {
          await this.sleep(350)
          continue
        }
      }
    }
    throw new Error(`SANDBOX_STEP_FAILED:${label}:${this.describeSandboxError(lastErr)}`)
  }

  // ─── Sandbox lifecycle ──────────────────────────────────────────────────────

  private async withSandbox<T>(
    fn: (sandbox: Sandbox) => Promise<T>,
    timeoutMs = 120_000
  ): Promise<T> {
    const snapshotId = process.env.AGENT_BROWSER_SNAPSHOT_ID
    let sandbox: Sandbox

    if (snapshotId) {
      // Fast path: snapshot pre-baked → arranque ~1s
      sandbox = await Sandbox.create({
        source: { type: "snapshot", snapshotId },
        timeout: timeoutMs,
      })
      console.log("[sandbox] started from snapshot")
    } else {
      // Cold start: instala chromium + agent-browser (~30s)
      sandbox = await this.bootstrapFreshSandbox(timeoutMs)
    }

    try {
      return await fn(sandbox)
    } catch (err) {
      const detail = this.describeSandboxError(err)
      console.error("[sandbox] run failed:", detail)
      throw err
    } finally {
      await sandbox.stop().catch(() => {})
    }
  }

  private async bootstrapFreshSandbox(timeoutMs: number): Promise<Sandbox> {
    console.log("[sandbox] cold start — bootstrapping (~30s first time)")
    const sb = await Sandbox.create({ runtime: "node24", timeout: timeoutMs })
    await sb.runCommand("sh", ["-c",
      `sudo dnf install -y --skip-broken ${CHROMIUM_DEPS.join(" ")} 2>&1 | tail -3`,
    ])
    await sb.runCommand("npm", ["install", "-g", "agent-browser"])
    await sb.runCommand("npx", ["agent-browser", "install"])
    console.log("[sandbox] bootstrap done")
    return sb
  }

  // ─── Cookie injection via CDP ───────────────────────────────────────────────

  private async injectCookies(sandbox: Sandbox): Promise<void> {
    try {
      await sandbox.writeFiles([
        { path: "/root/cookies.json", content: Buffer.from(JSON.stringify(this.cookies)) },
        { path: "/root/inject-cookies.mjs", content: Buffer.from(INJECT_COOKIES_MJS) },
      ])
    } catch (err) {
      const detail = this.describeSandboxError(err)
      throw new Error(`SANDBOX_STEP_FAILED:write-files:${detail}`)
    }
    // Primera apertura — arranca Chrome con CDP en puerto 9222
    await this.runSandboxCommand(sandbox, "open-blank", "agent-browser", ["open", "about:blank"], 2)
    // Inyectar cookies httpOnly via CDP antes de navegar a Spotify
    const result = await this.runSandboxCommand(sandbox, "inject-cookies", "node", ["/root/inject-cookies.mjs"], 1)
    const stderr = await result.stderr()
    if (stderr) console.log("[sandbox] inject stderr:", stderr.slice(0, 200))
    console.log("[sandbox] session cookies injected via CDP")
  }

  // ─── agent-browser command helpers ─────────────────────────────────────────

  private async agentOpen(sandbox: Sandbox, url: string): Promise<void> {
    await this.runSandboxCommand(sandbox, "open-url", "agent-browser", ["open", url], 2)
    // Esperar que el DOM esté disponible
    await this.runSandboxCommand(sandbox, "wait-body", "agent-browser", ["wait", "body"], 1).catch(() => {})
  }

  private async agentGetUrl(sandbox: Sandbox): Promise<string> {
    const r = await this.runSandboxCommand(sandbox, "get-url", "agent-browser", ["get", "url", "--json"], 1)
    try { return JSON.parse(await r.stdout())?.data?.url ?? "" } catch { return "" }
  }

  private async agentSnapshot(sandbox: Sandbox): Promise<AXElement[]> {
    const r = await this.runSandboxCommand(sandbox, "snapshot", "agent-browser", ["snapshot", "-i"], 1)
    return this.parseSnapshot(await r.stdout())
  }

  private parseSnapshot(raw: string): AXElement[] {
    const results: AXElement[] = []
    for (const line of raw.split("\n")) {
      // Formato: '  button "Create playlist" [@e5]'
      const m = line.match(/(\w+)\s+"([^"]+)"\s+\[@(e\d+)\]/)
      if (m) results.push({ role: m[1], name: m[2], ref: m[3] })
    }
    return results
  }

  private async agentClick(sandbox: Sandbox, ref: string): Promise<void> {
    await this.runSandboxCommand(sandbox, "click-ref", "agent-browser", ["click", `@${ref}`], 1)
    await this.sleep(400)
  }

  private async agentEval(sandbox: Sandbox, js: string): Promise<string> {
    const r = await this.runSandboxCommand(sandbox, "eval", "agent-browser", ["eval", js], 1)
    return (await r.stdout()).trim()
  }

  /**
   * Busca en el AX tree un elemento por label y lo clickea.
   * Si no está en el AX tree (Spotify a veces falla ARIA), usa eval JS como fallback.
   */
  private async findAndClick(
    sandbox: Sandbox,
    labels: string[],
    fallbackJs: string
  ): Promise<boolean> {
    try {
      const elements = await this.agentSnapshot(sandbox)
      for (const label of labels) {
        const el = elements.find(e =>
          e.name.toLowerCase().includes(label.toLowerCase())
        )
        if (el) {
          await this.agentClick(sandbox, el.ref)
          console.log(`[sandbox] AX click: "${el.name}" [@${el.ref}]`)
          return true
        }
      }
    } catch { /* si snapshot falla, caemos al eval */ }

    // Fallback CDP eval
    try {
      const result = await this.agentEval(sandbox, fallbackJs)
      const clicked = result !== "null" && result !== "false" && result !== "undefined" && result !== ""
      if (clicked) console.log(`[sandbox] eval click (AX fallback)`)
      return clicked
    } catch (e) {
      console.log("[sandbox] eval fallback failed:", String(e).slice(0, 180))
      return false
    }
  }

  private assertNotLogin(url: string): void {
    if (url.includes("accounts.spotify.com")) {
      throw new Error(
        "SPOTIFY_NOT_CONNECTED: Spotify redirected to login. Session expired — please reconnect."
      )
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms))
  }

  // ─── Public methods ─────────────────────────────────────────────────────────

  /**
   * Busca tracks — extracción DOM pura via eval, sin AI.
   */
  async searchTracks(
    query: string,
    limit = 10
  ): Promise<Array<{ name: string; artist: string; uri: string }>> {
    return this.withSandbox(async (sandbox) => {
      await this.injectCookies(sandbox)
      await this.agentOpen(
        sandbox,
        `https://open.spotify.com/search/${encodeURIComponent(query)}/tracks`
      )
      this.assertNotLogin(await this.agentGetUrl(sandbox))

      const json = await this.agentEval(sandbox, `
        JSON.stringify((() => {
          const seen = new Set(), results = [];
          for (const a of document.querySelectorAll('a[href^="/track/"]')) {
            const id = a.getAttribute('href').replace('/track/','').split('?')[0];
            if (!id || seen.has(id)) continue; seen.add(id);
            const name = a.textContent?.trim(); if (!name) continue;
            const row = a.closest('[data-testid="tracklist-row"]')
                     ?? a.closest('[role="row"]')
                     ?? a.parentElement?.parentElement;
            const artist = row?.querySelector('a[href^="/artist/"]')?.textContent?.trim() ?? '';
            results.push({ name, artist, uri: 'spotify:track:' + id });
            if (results.length >= ${limit}) break;
          }
          return results;
        })())
      `)

      try {
        return (JSON.parse(json) as Array<{ name: string; artist: string; uri: string }>)
          .filter(t => t.name && t.uri.startsWith("spotify:track:"))
      } catch { return [] }
    })
  }

  /**
   * Crea una playlist completa: crea → renombra → agrega tracks.
   * Todo dentro de un único microVM efímero.
   */
  async createPlaylist(
    name: string,
    description: string,
    trackQueries: string[]
  ): Promise<{ url: string; trackCount: number }> {
    return this.withSandbox(async (sandbox) => {
      console.log("[sandbox] injecting session and loading Spotify")
      await this.injectCookies(sandbox)
      await this.agentOpen(sandbox, "https://open.spotify.com")

      let url = await this.agentGetUrl(sandbox)
      this.assertNotLogin(url)
      await this.sleep(2000) // Web Player initialization

      // ── Cookie banner ─────────────────────────────────────────────────────
      await this.findAndClick(
        sandbox,
        ["Accept cookies", "Accept", "Reject"],
        `document.querySelector('[id*="accept" i],[data-testid*="accept" i]')?.click()`
      ).catch(() => {})

      // ── Crear playlist ────────────────────────────────────────────────────
      console.log("[sandbox] creating playlist")
      await this.findAndClick(
        sandbox,
        ["Create playlist", "New playlist"],
        `document.querySelector('[aria-label*="Create playlist" i],[aria-label*="New playlist" i]')?.click()`
      )
      await this.sleep(600)

      // Si aparece dropdown con "Playlist / Blend / Folder"
      await this.findAndClick(
        sandbox,
        ["Playlist"],
        `[...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.trim() === 'Playlist')?.click()`
      ).catch(() => {})
      await this.sleep(1500)

      // Esperar navegación a /playlist/{id}
      for (let i = 0; i < 12; i++) {
        url = await this.agentGetUrl(sandbox)
        if (url.includes("/playlist/")) break
        await this.sleep(700)
      }

      const playlistId = url.split("/playlist/")[1]?.split("?")[0]
      if (!playlistId) throw new Error("Could not navigate to playlist page")
      const canonicalUrl = `https://open.spotify.com/playlist/${playlistId}`
      console.log("[sandbox] playlist created:", canonicalUrl)

      // ── Renombrar ─────────────────────────────────────────────────────────
      console.log("[sandbox] renaming to:", name)
      await this.renamePlaylist(sandbox, name)

      // ── Agregar tracks ────────────────────────────────────────────────────
      console.log("[sandbox] adding", trackQueries.length, "tracks")
      let trackCount = 0
      for (const query of trackQueries.slice(0, 50)) {
        try {
          if (await this.addOneTrack(sandbox, query, name)) trackCount++
        } catch (e) {
          console.log("[sandbox] track failed:", query, String(e).slice(0, 60))
        }
      }

      console.log("[sandbox] done. tracks:", trackCount)
      return { url: canonicalUrl, trackCount }
    }, 600_000) // 10 min para playlists grandes
  }

  private async renamePlaylist(sandbox: Sandbox, name: string): Promise<void> {
    await this.sleep(500)

    // Estrategia 1: botón "Edit details" → modal con input
    const editClicked = await this.findAndClick(
      sandbox,
      ["Edit details", "Edit playlist"],
      `document.querySelector('[aria-label*="Edit details" i]')?.click()`
    )

    if (editClicked) {
      await this.sleep(700)
      // Actualizar el input name en React (requiere el setter nativo para componentes controlados)
      await this.agentEval(sandbox, `
        const inp = document.querySelector('input[name="name"], input[placeholder*="name" i]');
        if (inp) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(inp, ${JSON.stringify(name)});
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
      `)
      await this.sleep(300)
      // Save
      await this.findAndClick(
        sandbox,
        ["Save"],
        `document.querySelector('[aria-label="Save"],button[type="submit"]')?.click()`
      )
    } else {
      // Estrategia 2: title contenteditable directo
      await this.agentEval(sandbox, `
        const el = document.querySelector('[data-testid="playlist-title"], [contenteditable="true"]');
        if (el) {
          el.focus();
          document.execCommand('selectAll');
          document.execCommand('insertText', false, ${JSON.stringify(name)});
        }
      `)
      await this.sleep(200)
      await this.agentEval(sandbox, `document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}))`)
    }

    await this.sleep(500)
    console.log("[sandbox] rename done")
  }

  private async addOneTrack(
    sandbox: Sandbox,
    query: string,
    playlistName: string
  ): Promise<boolean> {
    await this.agentOpen(
      sandbox,
      `https://open.spotify.com/search/${encodeURIComponent(query)}/tracks`
    )
    await this.sleep(800)

    // Hover sobre el primer track row para revelar el botón ⋯
    await this.agentEval(sandbox, `
      document.querySelector('[data-testid="tracklist-row"], [role="row"]')
        ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    `)
    await this.sleep(400)

    // Click ⋯ (More options)
    const moreClicked = await this.findAndClick(
      sandbox,
      ["More options"],
      `document.querySelector('button[aria-label="More options"], [data-testid="more-button"]')?.click()`
    )
    if (!moreClicked) return false
    await this.sleep(400)

    // Click "Add to playlist"
    const addClicked = await this.findAndClick(
      sandbox,
      ["Add to playlist"],
      `[...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.includes('Add to playlist'))?.click()`
    )
    if (!addClicked) return false
    await this.sleep(600)

    // Click el nombre de la playlist en el submenú
    await this.findAndClick(
      sandbox,
      [playlistName],
      `[...document.querySelectorAll('[role="menuitem"], [role="option"]')]
        .find(el => el.textContent?.includes(${JSON.stringify(playlistName)}))?.click()`
    )
    await this.sleep(400)
    return true
  }

  /**
   * Busca un track y lo pone a reproducir en el Web Player.
   */
  async playTrack(query: string): Promise<{ name: string; artist: string }> {
    return this.withSandbox(async (sandbox) => {
      await this.injectCookies(sandbox)
      // Cargar homepage para inicializar el Web Player como dispositivo activo
      await this.agentOpen(sandbox, "https://open.spotify.com")
      await this.sleep(2000)

      await this.agentOpen(
        sandbox,
        `https://open.spotify.com/search/${encodeURIComponent(query)}/tracks`
      )
      this.assertNotLogin(await this.agentGetUrl(sandbox))
      await this.sleep(800)

      // Extraer info del primer track via DOM (sin AI)
      const infoJson = await this.agentEval(sandbox, `
        JSON.stringify((() => {
          const row = document.querySelector('[data-testid="tracklist-row"]');
          return {
            name: row?.querySelector('a[href^="/track/"]')?.textContent?.trim() ?? '',
            artist: row?.querySelector('a[href^="/artist/"]')?.textContent?.trim() ?? '',
          };
        })())
      `)
      const info = JSON.parse(infoJson) as { name: string; artist: string }

      // Hover + click play button
      await this.agentEval(sandbox, `
        document.querySelector('[data-testid="tracklist-row"]')
          ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      `)
      await this.sleep(400)
      await this.findAndClick(
        sandbox,
        ["Play"],
        `document.querySelector('[data-testid="play-button"], button[aria-label*="Play" i]')?.click()`
      )

      console.log("[sandbox] playTrack:", info.name, "-", info.artist)
      return { name: info.name || query, artist: info.artist }
    })
  }

  /**
   * Pausa o reanuda la reproducción via CDP eval (sin screenshots).
   */
  async pausePlayback(): Promise<void> {
    return this.withSandbox(async (sandbox) => {
      await this.injectCookies(sandbox)
      await this.agentOpen(sandbox, "https://open.spotify.com")
      await this.sleep(2500)

      await this.findAndClick(
        sandbox,
        ["Pause", "Play"],
        `document.querySelector('[data-testid="control-button-playpause"]')?.click()`
      )
      console.log("[sandbox] pausePlayback toggled")
    })
  }

  /**
   * Salta a la siguiente canción via CDP eval (sin screenshots).
   */
  async skipToNext(): Promise<void> {
    return this.withSandbox(async (sandbox) => {
      await this.injectCookies(sandbox)
      await this.agentOpen(sandbox, "https://open.spotify.com")
      await this.sleep(2500)

      await this.findAndClick(
        sandbox,
        ["Next", "Skip to next"],
        `document.querySelector('[data-testid="control-button-skip-forward"]')?.click()`
      )
      console.log("[sandbox] skipToNext clicked")
    })
  }

  /**
   * Lee la canción actual — extracción DOM pura, sin AI.
   */
  async getNowPlaying(): Promise<{ name: string; artist: string } | null> {
    return this.withSandbox(async (sandbox) => {
      await this.injectCookies(sandbox)
      await this.agentOpen(sandbox, "https://open.spotify.com")
      await this.sleep(2500)

      const json = await this.agentEval(sandbox, `
        JSON.stringify((() => {
          const track = document.querySelector('[data-testid="context-item-link"]')?.textContent?.trim();
          const artist = document.querySelector('[data-testid="context-item-info-artist"]')?.textContent?.trim();
          return track ? { name: track, artist: artist ?? '' } : null;
        })())
      `)
      try { return JSON.parse(json) } catch { return null }
    })
  }

  /**
   * Crea un snapshot del sandbox con agent-browser pre-instalado.
   * Correr UNA SOLA VEZ. Guardar el ID en AGENT_BROWSER_SNAPSHOT_ID.
   *
   * Con snapshot: cold start ~1s (vs ~30s sin snapshot).
   */
  async createSnapshot(): Promise<string> {
    console.log("[sandbox] creating snapshot — this takes ~2 minutes")
    const sb = await Sandbox.create({ runtime: "node24", timeout: 300_000 })
    await sb.runCommand("sh", ["-c",
      `sudo dnf install -y --skip-broken ${CHROMIUM_DEPS.join(" ")} 2>&1 | tail -3`,
    ])
    await sb.runCommand("npm", ["install", "-g", "agent-browser"])
    await sb.runCommand("npx", ["agent-browser", "install"])
    const snap = await sb.snapshot()
    console.log("[sandbox] snapshot ID:", snap.snapshotId)
    console.log("[sandbox] set AGENT_BROWSER_SNAPSHOT_ID=" + snap.snapshotId)
    return snap.snapshotId
  }
}

export function createAgent(storedCookies: object): SpotifyAgent {
  return new SpotifyAgent(storedCookies as SpotifyAgentCookie[])
}
