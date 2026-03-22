/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-vars */
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
