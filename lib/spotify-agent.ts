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
const INJECT_COOKIES_MJS = String.raw`
import http from 'node:http';
import { readFileSync } from 'node:fs';

const cookies = JSON.parse(readFileSync('/tmp/cookies.json', 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTargetsWithRetry(maxAttempts = 20) {
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const targets = await new Promise((ok, fail) => {
        const req = http.get('http://localhost:9222/json', (res) => {
          let d = '';
          res.on('data', (c) => d += c);
          res.on('end', () => {
            try {
              ok(JSON.parse(d));
            } catch (e) {
              fail(e);
            }
          });
          res.on('error', fail);
        });
        req.on('error', fail);
      });
      return targets;
    } catch (err) {
      lastErr = err;
      await sleep(300);
    }
  }
  throw lastErr ?? new Error('Could not connect to CDP on 127.0.0.1:9222');
}

const targets = await getTargetsWithRetry();

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

const PLAYWRIGHT_CREATE_PLAYLIST_CJS = String.raw`
const { readFileSync, writeFileSync } = require('node:fs');

function extractPlaylistIdsFromHrefs(hrefs) {
  const ids = hrefs
    .map((h) => {
      const m = String(h || '').match(/\/playlist\/([a-zA-Z0-9]+)/);
      return m ? m[1] : null;
    })
    .filter(Boolean);
  return [...new Set(ids)];
}

function normalizeName(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

async function listLibraryPlaylistHrefs(page) {
  return page.$$eval(
    [
      '[data-testid="rootlist"] a[href*="/playlist/"]',
      '[aria-label*="Your Library" i] a[href*="/playlist/"]',
      'nav a[href*="/playlist/"]',
    ].join(','),
    (els) => [...new Set(els.map((el) => el.getAttribute('href') || '').filter(Boolean))]
  ).catch(() => []);
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

async function ensurePlaylistsView(page) {
  await page.goto('https://open.spotify.com/collection/playlists', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(800);

  // Spotify sometimes lands on /collection/tracks despite direct navigation.
  if (page.url().includes('/collection/tracks')) {
    const switched = await clickFirst(page, [
      'a[href*="/collection/playlists"]',
      '[role="tab"][href*="/collection/playlists"]',
      '[role="tablist"] a[href*="playlists"]',
      'a[href*="playlists"]:has-text("Playlist")',
      'a[href*="playlists"]:has-text("Lista")',
    ], 1200);
    if (switched) await page.waitForTimeout(700);
  }
}

async function clickCreatePlaylistHeuristic(page) {
  const direct = await clickFirst(page, [
    'button[data-testid*="create-playlist" i]',
    '[data-testid*="create-playlist" i] button',
    '[data-testid*="add-button" i]',
    'button[aria-label*="playlist" i]',
    'button[aria-label*="create" i]',
  ], 2200);
  if (direct) return true;

  // Try to click library "+" button (often icon-only, locale-independent).
  const plusClicked = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button,[role="button"]')];
    const inLibrary = buttons.filter((el) =>
      el.closest('[data-testid*="library" i],[aria-label*="library" i],[aria-label*="biblioteca" i],nav,aside')
    );
    const scored = inLibrary.map((el) => {
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const testid = (el.getAttribute('data-testid') || '').toLowerCase();
      const text = (el.textContent || '').toLowerCase().trim();
      let score = 0;
      if (testid.includes('add') || testid.includes('create') || testid.includes('plus')) score += 8;
      if (aria.includes('create') || aria.includes('crear') || aria.includes('new') || aria.includes('nueva')) score += 7;
      if (aria.includes('playlist') || aria.includes('lista')) score += 6;
      if (text === '+' || text.includes('playlist') || text.includes('lista')) score += 4;
      if (el.querySelector('svg')) score += 1;
      return { el, score };
    }).sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < 3) return false;
    best.el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  }).catch(() => false);
  if (plusClicked) return true;

  const result = await page.evaluate(() => {
    const terms = ['create', 'new', 'playlist', 'crear', 'nueva', 'lista'];
    const nodes = [...document.querySelectorAll('button,[role="button"],a')];
    let best = null;
    let bestScore = -1;

    for (const el of nodes) {
      const text = (el.textContent || '').toLowerCase().trim();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase().trim();
      const testid = (el.getAttribute('data-testid') || '').toLowerCase().trim();
      const cls = (el.getAttribute('class') || '').toLowerCase();

      let score = 0;
      if (testid.includes('create')) score += 8;
      if (testid.includes('playlist')) score += 8;
      if (testid.includes('add')) score += 4;
      if (aria.includes('playlist') || aria.includes('lista')) score += 6;
      if (aria.includes('create') || aria.includes('crear') || aria.includes('new') || aria.includes('nueva')) score += 5;
      if (terms.some((t) => text.includes(t))) score += 4;
      if (cls.includes('sidebar') || cls.includes('library')) score += 2;
      if (el.closest('[data-testid*="library" i], [aria-label*="library" i], [aria-label*="biblioteca" i]')) score += 3;

      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    if (best && bestScore >= 7) {
      best.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return { clicked: true, bestScore };
    }
    return { clicked: false, bestScore };
  }).catch(() => ({ clicked: false, bestScore: -1 }));

  return Boolean(result?.clicked);
}

async function triggerKeyboardCreatePlaylist(page) {
  const combos = ['Control+N', 'Meta+N', 'Control+Shift+N', 'Meta+Shift+N'];
  for (const combo of combos) {
    try {
      await page.keyboard.press(combo);
      await page.waitForTimeout(450);
      return true;
    } catch {}
  }
  return false;
}

async function clickPlaylistMenuOption(page) {
  const viaSelector = await clickFirst(page, [
    '[role="menuitem"]:has-text("Playlist")',
    '[role="menuitem"]:has-text("playlist")',
    '[role="menuitem"]:has-text("Lista")',
    '[role="menuitem"]:has-text("lista")',
    'button:has-text("Playlist")',
    'button:has-text("Lista")',
  ], 1500);
  if (viaSelector) return true;

  return page.evaluate(() => {
    const terms = ['playlist', 'lista', 'reproducción', 'reproducao'];
    const items = [...document.querySelectorAll('[role="menuitem"],button,[role="button"]')];
    const target = items.find((el) => {
      const text = (el.textContent || '').toLowerCase();
      return terms.some((t) => text.includes(t));
    });
    if (!target) return false;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  }).catch(() => false);
}

async function ensureSearchTracksView(page, query) {
  await page.goto('https://open.spotify.com/search/' + encodeURIComponent(query) + '/tracks', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(450);

  if (page.url().includes('/tracks')) return;

  await clickFirst(page, [
    'a[href*="/tracks"]',
    '[role="tab"]:has-text("Tracks")',
    '[role="tab"]:has-text("Songs")',
    '[role="tab"]:has-text("Canciones")',
    '[role="tab"]:has-text("Musicas")',
  ], 1200);
  await page.waitForTimeout(350);
  await page.waitForSelector('a[href*="/track/"], [data-testid="tracklist-row"]', { timeout: 9000 }).catch(() => null);
}

async function collectTrackCandidates(page, limit = 20) {
  return page.evaluate((cap) => {
    const out = [];
    const seen = new Set();
    const links = [...document.querySelectorAll('a[href*="/track/"]')];
    for (const a of links) {
      const href = String(a.getAttribute('href') || '');
      const m = href.match(/\/track\/([a-zA-Z0-9]+)/);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      const row =
        a.closest('[data-testid="tracklist-row"]') ||
        a.closest('[role="row"]') ||
        a.closest('div[role="listitem"]') ||
        a.parentElement;
      const name = (a.textContent || '').trim();
      const artist = (row?.querySelector?.('a[href*="/artist/"]')?.textContent || '').trim();
      if (!name) continue;
      out.push({ id, name, artist, href, rowHasPlayButton: Boolean(row?.querySelector?.('[data-testid="play-button"], button[aria-label*="Play" i]')) });
      if (out.length >= cap) break;
    }
    return out;
  }, Math.max(1, Math.min(50, limit))).catch(() => []);
}

async function countPlaylistTrackLinks(page, playlistUrl) {
  await page.goto(playlistUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(900);
  const total = await page.$$eval('a[href*="/track/"]', (els) => {
    const ids = els
      .map((el) => {
        const m = String(el.getAttribute('href') || '').match(/\/track\/([a-zA-Z0-9]+)/);
        return m ? m[1] : null;
      })
      .filter(Boolean);
    return new Set(ids).size;
  }).catch(() => 0);
  return Number(total || 0);
}

async function collectCreateDiagnostics(page) {
  return page.evaluate(() => {
    const controls = [...document.querySelectorAll('button,[role="button"],a')]
      .slice(0, 120)
      .map((el) => ({
        text: (el.textContent || '').trim().slice(0, 80),
        aria: (el.getAttribute('aria-label') || '').trim().slice(0, 80),
        testid: (el.getAttribute('data-testid') || '').trim(),
        href: (el.getAttribute('href') || '').trim(),
      }))
      .filter((c) => c.text || c.aria || c.testid || c.href);
    return {
      url: location.href,
      controlsSample: controls.slice(0, 30),
      linksPlaylists: [...new Set([...document.querySelectorAll('a[href*="/playlist/"]')].map((a) => a.getAttribute('href') || '').filter(Boolean))].slice(0, 20),
    };
  }).catch(() => ({ url: page.url(), controlsSample: [], linksPlaylists: [] }));
}

async function addFirstSearchResultToPlaylist(page, playlistId, playlistName) {
  const row = page.locator([
    '[data-testid="tracklist-row"]:has(button[aria-haspopup="menu"])',
    '[data-testid="tracklist-row"]:has([data-testid="more-button"])',
    '[data-testid="tracklist-row"]',
    '[role="row"]:has(button[aria-haspopup="menu"])',
    '[role="row"]',
  ].join(',')).first();
  if (!(await row.count())) return { ok: false, reason: 'no_track_row' };

  await row.hover({ timeout: 1500 }).catch(() => null);
  const more = row.locator('button[aria-label*="More options" i], [data-testid="more-button"], button[aria-haspopup="menu"]').first();
  if (!(await more.count())) return { ok: false, reason: 'no_more_button' };
  await more.click({ timeout: 1800 }).catch(() => null);
  await page.waitForTimeout(220);

  // Strategy A: direct hit by playlist ID link if visible immediately.
  const directById = page.locator('a[href*="/playlist/' + playlistId + '"]').first();
  if (await directById.count()) {
    await directById.click({ timeout: 1800 }).catch(() => null);
    return { ok: true, reason: 'clicked_direct_id' };
  }

  // Strategy B: open/hover likely "Add to playlist" menuitem (language agnostic).
  const addTerms = ['add', 'añadir', 'agregar', 'adicionar', 'aggiungi', 'ajouter', 'hinzuf'];
  const items = page.locator('[role="menuitem"]');
  const itemCount = await items.count();
  let submenuOpened = false;

  for (let i = 0; i < Math.min(itemCount, 14); i++) {
    const item = items.nth(i);
    const txt = normalizeName(await item.textContent());
    const hasTerm = addTerms.some((t) => txt.includes(t));

    // Prefer semantic match; if absent, probe by hover then check if playlist links appear.
    if (hasTerm) {
      await item.hover({ timeout: 1200 }).catch(() => null);
      await item.click({ timeout: 1200 }).catch(() => null);
      await page.waitForTimeout(260);
      submenuOpened = true;
    } else {
      await item.hover({ timeout: 900 }).catch(() => null);
      await page.waitForTimeout(160);
    }

    const byId = page.locator('a[href*="/playlist/' + playlistId + '"], [role="menuitem"] a[href*="/playlist/' + playlistId + '"]').first();
    if (await byId.count()) {
      await byId.click({ timeout: 1800 }).catch(() => null);
      return { ok: true, reason: 'clicked_submenu_id' };
    }
  }

  // Strategy C: fallback by playlist name in visible options.
  const normalized = normalizeName(playlistName);
  const playlistOptions = page.locator('[role="menuitem"], [role="option"]');
  const optionCount = await playlistOptions.count();
  for (let i = 0; i < Math.min(optionCount, 14); i++) {
    const opt = playlistOptions.nth(i);
    const txt = normalizeName(await opt.textContent());
    if (!txt) continue;
    if (txt.includes(normalized) || normalized.includes(txt)) {
      await opt.click({ timeout: 1800 }).catch(() => null);
      return { ok: true, reason: 'clicked_name_match' };
    }
  }

  return { ok: false, reason: submenuOpened ? 'submenu_without_target_playlist' : 'no_add_menu_path' };
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

function trace(phase, extra = {}) {
  try {
    console.log('SPOTIFY_PW_TRACE=' + JSON.stringify({
      ts: new Date().toISOString(),
      phase,
      ...extra,
    }));
  } catch {}
}

let browser;
let page;
;(async () => {
try {
  trace('bootstrap_start');
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
  result.phase = 'open_library';
  trace('open_library_start');
  await ensurePlaylistsView(page);

  const currentUrl = page.url();
  if (currentUrl.includes('accounts.spotify.com')) {
    throw new Error('SPOTIFY_NOT_CONNECTED: redirected to accounts.spotify.com');
  }

  await clickFirst(page, [
    'button:has-text("Accept cookies")',
    'button:has-text("Accept")',
    'button[data-testid*="accept"]',
  ]).catch(() => false);

  const beforeHrefs = await listLibraryPlaylistHrefs(page);
  const beforeIds = extractPlaylistIdsFromHrefs(beforeHrefs);

  result.phase = 'create_playlist';
  trace('create_playlist_start');
  let created = await clickCreatePlaylistHeuristic(page);
  if (!created) {
    // second pass after forcing playlists view again
    await ensurePlaylistsView(page).catch(() => null);
    created = await clickCreatePlaylistHeuristic(page);
  }
  if (!created) {
    // third pass: keyboard shortcut fallback (UI-independent)
    created = await triggerKeyboardCreatePlaylist(page);
    await page.waitForTimeout(700);
  }

  if (!created) {
    const diag = await collectCreateDiagnostics(page);
    const controls = Array.isArray(diag?.controlsSample) ? diag.controlsSample : [];
    const hasLibrarySignals = controls.some((c) => {
      const joined = (String(c?.text || "") + " " + String(c?.aria || "") + " " + String(c?.testid || "")).toLowerCase();
      return joined.includes("library") || joined.includes("biblioteca") || joined.includes("playlist") || joined.includes("lista");
    });
    result.debug = {
      ...result.debug,
      createDiagnostics: diag,
    };
    if (String(diag?.url || '').includes('/collection/tracks') && !hasLibrarySignals) {
      throw new Error('SPOTIFY_NOT_CONNECTED: incomplete web session cookies (missing library controls). Reconnect with full Cookie header (sp_dc + sp_key).');
    }
    throw new Error('Could not click create playlist control');
  }
  trace('create_playlist_clicked');

  await page.waitForTimeout(700);
  await clickPlaylistMenuOption(page).catch(() => false);

  let playlistId = (() => {
    const m = page.url().match(/\/playlist\/([a-zA-Z0-9]+)/);
    return m ? m[1] : null;
  })();
  for (let i = 0; i < 18 && !playlistId; i++) {
    await page.waitForTimeout(450);
    playlistId = (() => {
      const m = page.url().match(/\/playlist\/([a-zA-Z0-9]+)/);
      return m ? m[1] : null;
    })();
    if (playlistId) break;
    const afterHrefs = await listLibraryPlaylistHrefs(page);
    const afterIds = extractPlaylistIdsFromHrefs(afterHrefs);
    playlistId = afterIds.find((id) => !beforeIds.includes(id)) || null;
  }

  if (!playlistId) {
    const afterHrefs = await listLibraryPlaylistHrefs(page);
    const afterIds = extractPlaylistIdsFromHrefs(afterHrefs);
    const currentUrlId = (() => {
      const m = page.url().match(/\/playlist\/([a-zA-Z0-9]+)/);
      return m ? m[1] : null;
    })();
    if (currentUrlId && !beforeIds.includes(currentUrlId)) {
      playlistId = currentUrlId;
    } else {
      playlistId = afterIds.find((id) => !beforeIds.includes(id)) || null;
    }
  }

  if (!playlistId) {
    // One more deterministic pass from playlists view before failing.
    await ensurePlaylistsView(page).catch(() => null);
    await page.waitForTimeout(500);
    const afterHrefs = await listLibraryPlaylistHrefs(page);
    const afterIds = extractPlaylistIdsFromHrefs(afterHrefs);
    playlistId = afterIds.find((id) => !beforeIds.includes(id)) || null;
  }

  if (!playlistId) {
    result.debug = {
      currentUrl: page.url(),
      beforePlaylistCount: beforeIds.length,
      beforeSample: beforeIds.slice(0, 6),
      phase: result.phase,
      ...(await collectCreateDiagnostics(page)),
    };
    throw new Error('Could not navigate to playlist page');
  }
  trace('playlist_resolved', { playlistId });

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
  trace('add_tracks_start', { queryCount: queries.length });

  let trackCount = 0;
  const trackFailures = [];
  for (const query of queries) {
    try {
      trace('add_track_query_start', { query });
      await ensureSearchTracksView(page, query);
      await page.waitForTimeout(350);
      const add = await addFirstSearchResultToPlaylist(page, playlistId, playlistName);
      if (add.ok) {
        trackCount++;
        trace('add_track_query_ok', { query, trackCount, reason: add.reason });
      } else if (trackFailures.length < 8) {
        trackFailures.push({ query, reason: add.reason, url: page.url() });
        trace('add_track_query_fail', { query, reason: add.reason, url: page.url() });
      }
      await page.waitForTimeout(250);
    } catch (err) {
      if (trackFailures.length < 8) {
        trackFailures.push({
          query,
          reason: 'exception',
          detail: err instanceof Error ? err.message.slice(0, 140) : String(err).slice(0, 140),
          url: page.url(),
        });
      }
      trace('add_track_query_exception', {
        query,
        error: err instanceof Error ? err.message.slice(0, 140) : String(err).slice(0, 140),
        url: page.url(),
      });
    }
  }

  if (trackFailures.length > 0) {
    result.debug = {
      ...result.debug,
      trackFailures,
      queryCount: queries.length,
    };
  }

  const finalTrackLinks = await countPlaylistTrackLinks(page, playlistUrl).catch(() => 0);
  result.debug = {
    ...result.debug,
    finalTrackLinks,
  };

  if (queries.length > 0 && (trackCount === 0 || finalTrackLinks === 0)) {
    throw new Error('No tracks were added to the created playlist');
  }

  trace('add_tracks_done', { trackCount, finalTrackLinks });

  result.ok = true;
  result.message = 'ok';
  result.url = playlistUrl;
  result.trackCount = trackCount;
} catch (err) {
  trace('fatal', { message: err instanceof Error ? err.message : String(err), phase: result.phase });
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

const PLAYWRIGHT_PLAYER_CONTROL_CJS = String.raw`
const { readFileSync, writeFileSync } = require('node:fs');

function normalizeText(s) {
  return String(s || '').toLowerCase().trim();
}

async function clickFirst(page, selectors, timeout = 1600) {
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

async function ensureSearchTracksView(page, query) {
  await page.goto('https://open.spotify.com/search/' + encodeURIComponent(query) + '/tracks', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(450);
  if (page.url().includes('/tracks')) return;
  await clickFirst(page, [
    'a[href*="/tracks"]',
    '[role="tab"]:has-text("Tracks")',
    '[role="tab"]:has-text("Songs")',
    '[role="tab"]:has-text("Canciones")',
    '[role="tab"]:has-text("Musicas")',
  ], 1200);
  await page.waitForTimeout(350);
  await page.waitForSelector('a[href*="/track/"], [data-testid="tracklist-row"]', { timeout: 9000 }).catch(() => null);
}

async function collectTrackCandidates(page, limit = 20) {
  return page.evaluate((cap) => {
    const out = [];
    const seen = new Set();
    const links = [...document.querySelectorAll('a[href*="/track/"]')];
    for (const a of links) {
      const href = String(a.getAttribute('href') || '');
      const m = href.match(/\/track\/([a-zA-Z0-9]+)/);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      const row =
        a.closest('[data-testid="tracklist-row"]') ||
        a.closest('[role="row"]') ||
        a.closest('div[role="listitem"]') ||
        a.parentElement;
      const name = (a.textContent || '').trim();
      const artist = (row?.querySelector?.('a[href*="/artist/"]')?.textContent || '').trim();
      if (!name) continue;
      out.push({ id, name, artist, href, rowHasPlayButton: Boolean(row?.querySelector?.('[data-testid="play-button"], button[aria-label*="Play" i]')) });
      if (out.length >= cap) break;
    }
    return out;
  }, Math.max(1, Math.min(50, limit))).catch(() => []);
}

const input = JSON.parse(readFileSync('/tmp/spotify-control-input.json', 'utf8'));
const result = { ok: false, message: '', data: null, debug: {} };

let browser;
let page;
;(async () => {
  try {
    let chromium;
    try {
      ({ chromium } = require('playwright'));
    } catch (err) {
      const root = process.env.PLAYWRIGHT_NODE_MODULES || '';
      if (!root) throw err;
      try {
        ({ chromium } = require(root + '/playwright'));
      } catch {
        ({ chromium } = require(root + '/playwright-core'));
      }
    }

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext();
    const cookies = (Array.isArray(input.cookies) ? input.cookies : []).filter((c) => c?.name && c?.value);
    if (cookies.length) await context.addCookies(cookies);
    page = await context.newPage();

    await page.goto('https://open.spotify.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1200);
    if (page.url().includes('accounts.spotify.com')) {
      throw new Error('SPOTIFY_NOT_CONNECTED: redirected to login');
    }

    const action = String(input.action || '');
    if (action === 'search_tracks') {
      const limit = Math.max(1, Math.min(20, Number(input.limit || 10)));
      const query = String(input.query || '');
      await ensureSearchTracksView(page, query);
      const candidates = await collectTrackCandidates(page, limit);
      const tracks = candidates.map((c) => ({ name: c.name, artist: c.artist, uri: 'spotify:track:' + c.id }));
      result.ok = true;
      result.data = tracks;
    } else if (action === 'play_track') {
      const query = String(input.query || '');
      await ensureSearchTracksView(page, query);
      const candidates = await collectTrackCandidates(page, 10);
      if (!candidates.length) throw new Error('No tracks found on search page');
      const first = candidates[0];

      // Prefer explicit row play button, fallback to open track link and hit top play.
      const clicked = await clickFirst(page, [
        '[data-testid="tracklist-row"] [data-testid="play-button"]',
        '[data-testid="tracklist-row"] button[aria-label*="Play" i]',
        'button[aria-label*="Play" i]',
      ], 1400);
      if (!clicked && first?.href) {
        const href = first.href.startsWith('http') ? first.href : ('https://open.spotify.com' + first.href);
        await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
        await page.waitForTimeout(700);
      }
      const clickedFallback = clicked || await clickFirst(page, [
        '[data-testid="control-button-playpause"]',
        'button[data-testid="play-button"]',
        'button[aria-label*="Play" i]',
      ], 1600);
      if (!clickedFallback) throw new Error('Could not click play control');
      result.ok = true;
      result.data = { name: first.name || query, artist: first.artist || '' };
    } else if (action === 'pause_playback') {
      const clicked = await clickFirst(page, ['[data-testid="control-button-playpause"]', 'button[aria-label*="Pause" i]', 'button[aria-label*="Play" i]'], 1400);
      if (!clicked) throw new Error('Could not toggle play/pause');
      result.ok = true;
      result.data = { ok: true };
    } else if (action === 'skip_next') {
      const clicked = await clickFirst(page, ['[data-testid="control-button-skip-forward"]', 'button[aria-label*="Next" i]'], 1400);
      if (!clicked) throw new Error('Could not click next');
      result.ok = true;
      result.data = { ok: true };
    } else if (action === 'now_playing') {
      const now = await page.evaluate(() => {
        const candidates = [
          '[data-testid="context-item-link"]',
          '[data-testid="nowplaying-track-link"]',
          'a[href*="/track/"]',
        ];
        let name = '';
        for (const sel of candidates) {
          const txt = (document.querySelector(sel)?.textContent || '').trim();
          if (txt) { name = txt; break; }
        }
        const artist = (document.querySelector('[data-testid="context-item-info-artist"]')?.textContent || '').trim();
        return name ? { name, artist } : null;
      }).catch(() => null);
      result.ok = true;
      result.data = now;
    } else {
      throw new Error('Unknown action: ' + action);
    }
  } catch (err) {
    result.ok = false;
    result.message = err instanceof Error ? err.message : String(err);
    result.debug = {
      currentUrl: page ? page.url() : null,
      action: input?.action || null,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { writeFileSync('/tmp/spotify-control-result.json', JSON.stringify(result), 'utf8'); } catch {}
    try { console.log('SPOTIFY_PW_CONTROL_RESULT=' + JSON.stringify(result)); } catch {}
  }
})().catch((err) => {
  const fatal = {
    ok: false,
    message: err instanceof Error ? err.message : String(err),
    data: null,
    debug: { phase: 'bootstrap' },
  };
  try { writeFileSync('/tmp/spotify-control-result.json', JSON.stringify(fatal), 'utf8'); } catch {}
  try { console.log('SPOTIFY_PW_CONTROL_RESULT=' + JSON.stringify(fatal)); } catch {}
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

    // Detect JS syntax/runtime bootstrap issues early with actionable stderr.
    const syntaxCheck = await this.runSandboxCommand(
      sandbox,
      "playwright-script-syntax-check",
      "node",
      ["--check", "/tmp/pw-create-playlist.cjs"],
      0
    ).catch(async (err) => {
      const detail = this.describeSandboxError(err)
      throw new Error(`PLAYLIST_CREATE_FAILED:Playwright script check failed: ${detail}`)
    })
    const syntaxStderr = await syntaxCheck.stderr().catch(() => "")
    if (syntaxStderr?.trim()) {
      throw new Error(
        `PLAYLIST_CREATE_FAILED:Playwright script check failed: ${syntaxStderr.slice(0, 700)}`
      )
    }

    const runner = `
      const fs = require('node:fs');
      try {
        require('/tmp/pw-create-playlist.cjs');
      } catch (err) {
        const fatal = {
          ok: false,
          message: 'bootstrap:' + (err && err.message ? err.message : String(err)),
          url: null,
          trackCount: 0,
          phase: 'bootstrap',
          debug: {
            stack: err && err.stack ? String(err.stack).slice(0, 1200) : null,
          },
        };
        try { fs.writeFileSync('/tmp/spotify-pw-result.json', JSON.stringify(fatal), 'utf8'); } catch {}
        try { console.log('SPOTIFY_PW_RESULT=' + JSON.stringify(fatal)); } catch {}
        process.exit(0);
      }
    `.trim()
    await sandbox.writeFiles([{ path: "/tmp/pw-runner.cjs", content: Buffer.from(runner) }])

    const run = await this.runSandboxCommand(
      sandbox,
      "playwright-create-playlist",
      "sh",
      [
        "-lc",
        "export PLAYWRIGHT_NODE_MODULES=/tmp/pw-runtime/node_modules PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-runtime/ms-playwright; node /tmp/pw-runner.cjs || true",
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

  private async runPlaywrightPlayerControl<T>(sandbox: Sandbox, input: Record<string, unknown>): Promise<T> {
    await this.ensurePlaywrightReady(sandbox)
    await sandbox.writeFiles([
      { path: "/tmp/spotify-control-input.json", content: Buffer.from(JSON.stringify({ ...input, cookies: this.cookies })) },
      { path: "/tmp/pw-player-control.cjs", content: Buffer.from(PLAYWRIGHT_PLAYER_CONTROL_CJS) },
    ])

    await this.runSandboxCommand(
      sandbox,
      "playwright-control-script-check",
      "node",
      ["--check", "/tmp/pw-player-control.cjs"],
      0
    ).catch((err) => {
      throw new Error(`PLAYWRIGHT_CONTROL_FAILED:script-check:${this.describeSandboxError(err)}`)
    })

    const run = await this.runSandboxCommand(
      sandbox,
      "playwright-player-control",
      "sh",
      [
        "-lc",
        "export PLAYWRIGHT_NODE_MODULES=/tmp/pw-runtime/node_modules PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-runtime/ms-playwright; node /tmp/pw-player-control.cjs || true",
      ],
      0
    )
    const stdout = await run.stdout()
    const stderr = await run.stderr()
    const merged = [stdout, stderr].join("\n")
    const marker = "SPOTIFY_PW_CONTROL_RESULT="
    const line = merged
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith(marker))

    let parsed: { ok: boolean; message?: string; data?: unknown; debug?: unknown } | null = null
    if (line) {
      parsed = JSON.parse(line.slice(marker.length))
    } else {
      const fallback = await this.runSandboxCommand(
        sandbox,
        "read-playwright-control-result-file",
        "sh",
        ["-lc", "cat /tmp/spotify-control-result.json 2>/dev/null || true"],
        0
      )
      const raw = (await fallback.stdout()).trim()
      if (raw) {
        try { parsed = JSON.parse(raw) } catch { parsed = null }
      }
    }

    if (!parsed) {
      throw new Error(`PLAYWRIGHT_CONTROL_FAILED:missing-result:${merged.slice(-600)}`)
    }
    if (!parsed.ok) {
      const detail = parsed.debug ? ` debug=${JSON.stringify(parsed.debug).slice(0, 500)}` : ""
      throw new Error(`PLAYWRIGHT_CONTROL_FAILED:${parsed.message ?? "unknown"}${detail}`)
    }
    return (parsed.data as T)
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
      const tracks = await this.runPlaywrightPlayerControl<Array<{ name: string; artist: string; uri: string }>>(
        sandbox,
        { action: "search_tracks", query, limit }
      )
      return Array.isArray(tracks)
        ? tracks.filter((t) => t?.name && String(t?.uri || "").startsWith("spotify:track:"))
        : []
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
      const info = await this.runPlaywrightPlayerControl<{ name: string; artist: string }>(sandbox, {
        action: "play_track",
        query,
      })
      console.log("[sandbox] playTrack:", info.name, "-", info.artist)
      return { name: info.name || query, artist: info.artist }
    })
  }

  /**
   * Pausa o reanuda la reproducción via CDP eval (sin screenshots).
   */
  async pausePlayback(): Promise<void> {
    return this.withSandbox(async (sandbox) => {
      await this.runPlaywrightPlayerControl<{ ok: boolean }>(sandbox, { action: "pause_playback" })
      console.log("[sandbox] pausePlayback toggled")
    })
  }

  /**
   * Salta a la siguiente canción via CDP eval (sin screenshots).
   */
  async skipToNext(): Promise<void> {
    return this.withSandbox(async (sandbox) => {
      await this.runPlaywrightPlayerControl<{ ok: boolean }>(sandbox, { action: "skip_next" })
      console.log("[sandbox] skipToNext clicked")
    })
  }

  /**
   * Lee la canción actual — extracción DOM pura, sin AI.
   */
  async getNowPlaying(): Promise<{ name: string; artist: string } | null> {
    return this.withSandbox(async (sandbox) => {
      const now = await this.runPlaywrightPlayerControl<{ name: string; artist: string } | null>(
        sandbox,
        { action: "now_playing" }
      )
      return now
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
