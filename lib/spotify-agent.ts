/**
 * SpotifyAgent — Vercel Sandbox automation for Spotify Web.
 *
 * Arquitectura:
 * 1. @vercel/sandbox crea un microVM Firecracker efímero
 * 2. Para createPlaylist usa Playwright dentro del VM (robusto ante cambios UI)
 * 3. Para acciones ligeras mantiene agent-browser (AX/CDP) por costo/latencia
 * 4. Al terminar, el VM se destruye — sin estado residual
 *
 * No usa la API oficial de Spotify.
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

const cookies = JSON.parse(readFileSync('/tmp/cookies.json', 'utf8'));

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

const PLAYWRIGHT_CREATE_PLAYLIST_CJS = `
const { readFileSync, writeFileSync } = require('node:fs');

function extractPlaylistIdsFromHrefs(hrefs) {
  const ids = hrefs
    .map((h) => String(h || '').match(/\\/playlist\\/([a-zA-Z0-9]+)/)?.[1] || null)
    .filter(Boolean);
  return [...new Set(ids)];
}

async function clickFirst(page, selectors, timeout = 1800) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.count()) {
        await locator.click({ timeout });
        return true;
      }
    } catch {}
  }
  return false;
}

const input = JSON.parse(readFileSync('/tmp/spotify-playlist-input.json', 'utf8'));
const result = {
  ok: false,
  message: '',
  url: null,
  trackCount: 0,
  phase: '',
  debug: {},
};

let browser;
let page;
;(async () => {
try {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (err) {
    const nodeModulesRoot = process.env.PLAYWRIGHT_NODE_MODULES || '';
    if (!nodeModulesRoot) throw err;
    try {
      ({ chromium } = require(nodeModulesRoot + '/playwright'));
    } catch {
      ({ chromium } = require(nodeModulesRoot + '/playwright-core'));
    }
  }
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext();

  const cookies = (Array.isArray(input.cookies) ? input.cookies : []).map((c) => {
    const sameSite = c?.sameSite === 'Strict' || c?.sameSite === 'Lax' || c?.sameSite === 'None'
      ? c.sameSite
      : 'Lax';
    const domain = String(c?.domain || '.spotify.com');
    return {
      name: String(c?.name || ''),
      value: String(c?.value || ''),
      domain,
      path: String(c?.path || '/'),
      httpOnly: Boolean(c?.httpOnly),
      secure: c?.secure !== false,
      sameSite,
      expires: typeof c?.expires === 'number' ? c.expires : undefined,
    };
  }).filter((c) => c.name && c.value);
  if (cookies.length) await context.addCookies(cookies);

  page = await context.newPage();
  result.phase = 'open_home';
  await page.goto('https://open.spotify.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);

  const currentUrl = page.url();
  if (currentUrl.includes('accounts.spotify.com')) {
    throw new Error('SPOTIFY_NOT_CONNECTED: redirected to accounts.spotify.com');
  }

  await clickFirst(page, [
    'button:has-text("Accept cookies")',
    'button:has-text("Accept")',
    'button[data-testid*="accept"]',
  ]).catch(() => false);

  const beforeHrefs = await page.$$eval('a[href*="/playlist/"]', (els) =>
    [...new Set(els.map((el) => el.getAttribute('href') || ''))]
  ).catch(() => []);
  const beforeIds = extractPlaylistIdsFromHrefs(beforeHrefs);

  result.phase = 'create_playlist';
  let created = await clickFirst(page, [
    'button[aria-label*="Create playlist" i]',
    'button[aria-label*="Create a playlist" i]',
    'button[aria-label*="New playlist" i]',
    '[data-testid*="create-playlist" i]',
    'button:has-text("Create playlist")',
    'button:has-text("New playlist")',
    'button:has-text("Create")',
  ], 2500);
  if (!created) {
    await page.locator('button,[role="button"],a').evaluateAll((els) => {
      const target = els.find((el) => {
        const t = (el.textContent || '').trim().toLowerCase();
        const a = (el.getAttribute('aria-label') || '').toLowerCase();
        return t === 'create' || a.includes('create playlist') || a.includes('new playlist');
      });
      if (target) target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return Boolean(target);
    }).catch(() => false);
    created = true;
  }

  await page.waitForTimeout(700);
  await clickFirst(page, [
    '[role="menuitem"]:has-text("Playlist")',
    'button:has-text("Playlist")',
    '[role="button"]:has-text("Playlist")',
  ], 1500).catch(() => false);

  let playlistId = page.url().match(/\\/playlist\\/([a-zA-Z0-9]+)/)?.[1] || null;
  for (let i = 0; i < 18 && !playlistId; i++) {
    await page.waitForTimeout(450);
    playlistId = page.url().match(/\\/playlist\\/([a-zA-Z0-9]+)/)?.[1] || null;
    if (playlistId) break;
    const afterHrefs = await page.$$eval('a[href*="/playlist/"]', (els) =>
      [...new Set(els.map((el) => el.getAttribute('href') || ''))]
    ).catch(() => []);
    const afterIds = extractPlaylistIdsFromHrefs(afterHrefs);
    playlistId = afterIds.find((id) => !beforeIds.includes(id)) || null;
  }

  if (!playlistId) {
    const afterHrefs = await page.$$eval('a[href*="/playlist/"]', (els) =>
      [...new Set(els.map((el) => el.getAttribute('href') || ''))]
    ).catch(() => []);
    const afterIds = extractPlaylistIdsFromHrefs(afterHrefs);
    playlistId = afterIds[0] || null;
  }

  if (!playlistId) {
    result.debug = {
      currentUrl: page.url(),
      beforePlaylistCount: beforeIds.length,
      phase: result.phase,
    };
    throw new Error('Could not navigate to playlist page');
  }

  const playlistUrl = 'https://open.spotify.com/playlist/' + playlistId;
  result.phase = 'open_playlist';
  await page.goto(playlistUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(900);

  result.phase = 'rename_playlist';
  const playlistName = String(input.name || 'New Playlist');
  const didOpenEdit = await clickFirst(page, [
    'button[aria-label*="Edit details" i]',
    'button[aria-label*="Edit playlist" i]',
    'button:has-text("Edit details")',
    'button:has-text("Edit playlist")',
  ], 1500);

  if (didOpenEdit) {
    await page.waitForTimeout(500);
    const nameInput = page.locator('input[name="name"], input[placeholder*="name" i]').first();
    if (await nameInput.count()) {
      await nameInput.fill(playlistName, { timeout: 2000 }).catch(() => {});
    }
    await clickFirst(page, [
      'button[aria-label="Save"]',
      'button[type="submit"]',
      'button:has-text("Save")',
    ], 1500).catch(() => false);
  }

  result.phase = 'add_tracks';
  const queries = (Array.isArray(input.trackQueries) ? input.trackQueries : [])
    .map((q) => String(q || '').trim())
    .filter(Boolean)
    .slice(0, 50);

  let trackCount = 0;
  for (const query of queries) {
    try {
      await page.goto(
        'https://open.spotify.com/search/' + encodeURIComponent(query) + '/tracks',
        { waitUntil: 'domcontentloaded', timeout: 60000 }
      );
      await page.waitForTimeout(700);
      const row = page.locator('[data-testid="tracklist-row"], [role="row"]').first();
      if (!(await row.count())) continue;
      await row.hover({ timeout: 1500 }).catch(() => {});
      await row.locator('button[aria-label*="More options" i], [data-testid="more-button"], button[aria-haspopup="menu"]')
        .first()
        .click({ timeout: 1800 });
      const addMenuItem = page.locator('[role="menuitem"]').filter({ hasText: /Add to playlist/i }).first();
      if (await addMenuItem.count()) {
        await addMenuItem.click({ timeout: 1800 });
      } else {
        continue;
      }
      await page.waitForTimeout(350);
      const playlistOption = page.locator('[role="menuitem"], [role="option"]').filter({ hasText: playlistName }).first();
      if (await playlistOption.count()) {
        await playlistOption.click({ timeout: 1800 });
        trackCount++;
      }
      await page.waitForTimeout(250);
    } catch {}
  }

  result.ok = true;
  result.message = 'ok';
  result.url = playlistUrl;
  result.trackCount = trackCount;
} catch (err) {
  result.ok = false;
  result.message = err instanceof Error ? err.message : String(err);
  result.debug = {
    ...result.debug,
    playwrightNodeModules: process.env.PLAYWRIGHT_NODE_MODULES || '',
    playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH || '',
  };
  try {
    if (page) {
      const screenshotPath = '/tmp/spotify-playlist-error.png';
      const htmlPath = '/tmp/spotify-playlist-error.html';
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      writeFileSync(htmlPath, await page.content(), 'utf8');
      result.debug = {
        ...result.debug,
        currentUrl: page.url(),
        screenshotPath,
        htmlPath,
      };
    }
  } catch {}
} finally {
  if (browser) await browser.close().catch(() => {});
  try { writeFileSync('/tmp/spotify-pw-result.json', JSON.stringify(result), 'utf8'); } catch {}
  try { console.log('SPOTIFY_PW_RESULT=' + JSON.stringify(result)); } catch {}
}
})().catch((err) => {
  const fatal = {
    ok: false,
    message: err instanceof Error ? err.message : String(err),
    url: null,
    trackCount: 0,
    phase: 'bootstrap',
    debug: {
      playwrightNodeModules: process.env.PLAYWRIGHT_NODE_MODULES || '',
    },
  };
  try { writeFileSync('/tmp/spotify-pw-result.json', JSON.stringify(fatal), 'utf8'); } catch {}
  try { console.log('SPOTIFY_PW_RESULT=' + JSON.stringify(fatal)); } catch {}
});
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
        const res = await sandbox.runCommand(cmd, args)
        const exitCode = typeof res.exitCode === "number" ? res.exitCode : null
        if (exitCode !== null && exitCode !== 0) {
          const stderr = await res.stderr().catch(() => "")
          throw new Error(
            `command exited with code ${exitCode}` +
            (stderr ? `; stderr=${stderr.slice(0, 400)}` : "")
          )
        }
        return res
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

  private async ensurePlaywrightReady(sandbox: Sandbox): Promise<void> {
    const probe = await this.runSandboxCommand(
      sandbox,
      "playwright-probe",
      "sh",
      [
        "-lc",
        "node -e \"require('/tmp/pw-runtime/node_modules/playwright') || require('/tmp/pw-runtime/node_modules/playwright-core'); console.log('ok')\"",
      ],
      0
    ).catch(() => null)
    if (probe) return

    console.log("[sandbox] installing playwright in /tmp/pw-runtime (one-time per sandbox)")
    await this.runSandboxCommand(
      sandbox,
      "install-playwright-package",
      "sh",
      [
        "-lc",
        [
          "mkdir -p /tmp/pw-runtime",
          "cd /tmp/pw-runtime",
          "[ -f package.json ] || npm init -y >/dev/null 2>&1",
          "npm install playwright playwright-core --no-audit --no-fund",
          "test -f /tmp/pw-runtime/node_modules/playwright/package.json || test -f /tmp/pw-runtime/node_modules/playwright-core/package.json",
        ].join(" && "),
      ],
      1
    )
    await this.runSandboxCommand(
      sandbox,
      "install-playwright-browser",
      "sh",
      [
        "-lc",
        "cd /tmp/pw-runtime && PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-runtime/ms-playwright npx playwright install chromium",
      ],
      1
    )
    await this.runSandboxCommand(
      sandbox,
      "verify-playwright-runtime",
      "sh",
      [
        "-lc",
        "ls -la /tmp/pw-runtime/node_modules | sed -n '1,80p' && ls -la /tmp/pw-runtime/ms-playwright | sed -n '1,80p'",
      ],
      0
    ).catch(() => null)
  }

  private async runPlaywrightPlaylistFlow(
    sandbox: Sandbox,
    name: string,
    description: string,
    trackQueries: string[]
  ): Promise<{ url: string; trackCount: number }> {
    await this.ensurePlaywrightReady(sandbox)

    const input = {
      name,
      description,
      trackQueries,
      cookies: this.cookies,
    }
    await sandbox.writeFiles([
      { path: "/tmp/spotify-playlist-input.json", content: Buffer.from(JSON.stringify(input)) },
      { path: "/tmp/pw-create-playlist.cjs", content: Buffer.from(PLAYWRIGHT_CREATE_PLAYLIST_CJS) },
    ])

    const run = await this.runSandboxCommand(
      sandbox,
      "playwright-create-playlist",
      "sh",
      [
        "-lc",
        "export PLAYWRIGHT_NODE_MODULES=/tmp/pw-runtime/node_modules PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-runtime/ms-playwright; node /tmp/pw-create-playlist.cjs || true",
      ],
      0
    )
    const stdout = await run.stdout()
    const stderr = await run.stderr()
    if (stderr?.trim()) {
      console.error("[sandbox][playwright] stderr:", stderr.slice(0, 600))
    }

    const marker = "SPOTIFY_PW_RESULT="
    const mergedOutput = [stdout, stderr].join("\n")
    const line = mergedOutput
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith(marker))
    let parsed: {
      ok: boolean
      message?: string
      url?: string | null
      trackCount?: number
      phase?: string
      debug?: Record<string, unknown>
    } | null = null

    if (line) {
      parsed = JSON.parse(line.slice(marker.length))
    } else {
      const fallback = await this.runSandboxCommand(
        sandbox,
        "read-playwright-result-file",
        "sh",
        ["-lc", "cat /tmp/spotify-pw-result.json 2>/dev/null || true"],
        0
      )
      const fallbackRaw = (await fallback.stdout()).trim()
      if (fallbackRaw) {
        try {
          parsed = JSON.parse(fallbackRaw)
        } catch {
          parsed = null
        }
      }
    }
    if (!parsed) {
      throw new Error(`Playwright result not found in sandbox output: ${mergedOutput.slice(-600)}`)
    }

    if (!parsed.ok || !parsed.url) {
      const detail = parsed.debug ? ` debug=${JSON.stringify(parsed.debug).slice(0, 500)}` : ""
      const phase = parsed.phase ? ` phase=${parsed.phase}` : ""
      throw new Error(`PLAYLIST_CREATE_FAILED:${parsed.message ?? "unknown"}${phase}${detail}`)
    }

    return {
      url: parsed.url,
      trackCount: parsed.trackCount ?? 0,
    }
  }

  // ─── Cookie injection via CDP ───────────────────────────────────────────────

  private async injectCookies(sandbox: Sandbox): Promise<void> {
    try {
      await sandbox.writeFiles([
        { path: "/tmp/cookies.json", content: Buffer.from(JSON.stringify(this.cookies)) },
        { path: "/tmp/inject-cookies.mjs", content: Buffer.from(INJECT_COOKIES_MJS) },
      ])
    } catch (err) {
      const detail = this.describeSandboxError(err)
      throw new Error(`SANDBOX_STEP_FAILED:write-files:${detail}`)
    }
    // Primera apertura — arranca Chrome con CDP en puerto 9222
    await this.runSandboxCommand(sandbox, "open-blank", "agent-browser", ["open", "about:blank"], 2)
    // Inyectar cookies httpOnly via CDP antes de navegar a Spotify
    const result = await this.runSandboxCommand(
      sandbox,
      "inject-cookies",
      "node",
      ["/tmp/inject-cookies.mjs"],
      1
    )
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

  private extractPlaylistId(href: string): string | null {
    const m = href.match(/\/playlist\/([a-zA-Z0-9]+)/)
    return m?.[1] ?? null
  }

  private async readVisiblePlaylistIds(sandbox: Sandbox): Promise<string[]> {
    const raw = await this.agentEval(sandbox, `
      JSON.stringify((() => {
        const hrefs = [...document.querySelectorAll('a[href*="/playlist/"]')]
          .map(a => a.getAttribute('href') || '')
          .filter(Boolean);
        return [...new Set(hrefs)].slice(0, 80);
      })())
    `).catch(() => "[]")

    let parsed: unknown = []
    try { parsed = JSON.parse(raw) } catch { /* ignore */ }
    const hrefs = Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : []
    const ids = hrefs
      .map((href) => this.extractPlaylistId(href))
      .filter((v): v is string => Boolean(v))
    return [...new Set(ids)]
  }

  private async resolvePlaylistUrlAfterCreate(
    sandbox: Sandbox,
    currentUrl: string,
    knownPlaylistIdsBefore: string[]
  ): Promise<string | null> {
    const directId = this.extractPlaylistId(currentUrl)
    if (directId) return `https://open.spotify.com/playlist/${directId}`

    // Fallback: scrape candidate links and infer the newly created playlist.
    const scraped = await this.agentEval(sandbox, `
      JSON.stringify((() => {
        const links = [...document.querySelectorAll('a[href*="/playlist/"]')]
          .map(a => (a.getAttribute('href') || ''))
          .filter(Boolean);
        const uniq = [...new Set(links)];
        return uniq.slice(0, 120);
      })())
    `).catch(() => "[]")

    let candidates: unknown = []
    try { candidates = JSON.parse(scraped) } catch { /* ignore */ }
    const candidateList = Array.isArray(candidates)
      ? candidates.filter((v): v is string => typeof v === "string")
      : []
    const candidateIds = candidateList
      .map((href) => this.extractPlaylistId(href))
      .filter((v): v is string => Boolean(v))
    const uniqueIds = [...new Set(candidateIds)]
    if (uniqueIds.length === 0) return null

    const known = new Set(knownPlaylistIdsBefore)
    const createdId = uniqueIds.find((id) => !known.has(id)) ?? uniqueIds[0]
    return `https://open.spotify.com/playlist/${createdId}`
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
      console.log("[sandbox] creating playlist via Playwright flow")
      const created = await this.runPlaywrightPlaylistFlow(sandbox, name, description, trackQueries)
      console.log("[sandbox] playlist created:", created.url, "tracks:", created.trackCount)
      return created
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
    await sb.runCommand("npm", ["install", "-g", "playwright"])
    await sb.runCommand("npx", ["playwright", "install", "chromium"])
    const snap = await sb.snapshot()
    console.log("[sandbox] snapshot ID:", snap.snapshotId)
    console.log("[sandbox] set AGENT_BROWSER_SNAPSHOT_ID=" + snap.snapshotId)
    return snap.snapshotId
  }
}

export function createAgent(storedCookies: object): SpotifyAgent {
  return new SpotifyAgent(storedCookies as SpotifyAgentCookie[])
}
