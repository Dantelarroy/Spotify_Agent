/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-vars */
const { readFileSync, writeFileSync } = require('node:fs');

function normalizeText(s) {
  return String(s || '').toLowerCase().trim();
}

function hasRequiredCookies(cookies) {
  const names = new Set(
    (Array.isArray(cookies) ? cookies : [])
      .map((c) => String(c?.name || ''))
      .filter(Boolean)
  );
  return names.has('sp_dc') && names.has('sp_key');
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
    'button[href*="/tracks"]',
    '[role="tab"]:has-text("Tracks")',
    '[role="tab"]:has-text("Songs")',
    '[role="tab"]:has-text("Canciones")',
    '[role="tab"]:has-text("Musicas")',
    'button:has-text("Tracks")',
    'button:has-text("Songs")',
    'button:has-text("Canciones")',
  ], 1200);
  await page.waitForTimeout(350);
  if (page.url().includes('accounts.spotify.com')) {
    throw new Error('SPOTIFY_NOT_CONNECTED: redirected to accounts.spotify.com');
  }
  const hasLoginWall = await page.evaluate(() => {
    const txt = (document.body?.innerText || '').toLowerCase();
    return txt.includes('log in') || txt.includes('inicia sesión') || txt.includes('iniciar sesión');
  }).catch(() => false);
  if (hasLoginWall) {
    throw new Error('SPOTIFY_NOT_CONNECTED: search page is behind login wall');
  }
  await page.waitForSelector('a[href*="/track/"], [data-testid="tracklist-row"]', { timeout: 9000 }).catch(() => null);
  const hasAny = await page.$$eval('a[href*="/track/"], [data-testid="tracklist-row"]', (els) => els.length).catch(() => 0);
  if (!hasAny) {
    await page.goto('https://open.spotify.com/search/' + encodeURIComponent(query), {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    }).catch(() => null);
    await page.waitForTimeout(500);
    await clickFirst(page, [
      'a[href*="/tracks"]',
      'button[href*="/tracks"]',
      '[role="tab"]:has-text("Tracks")',
      '[role="tab"]:has-text("Songs")',
      '[role="tab"]:has-text("Canciones")',
      '[role="tab"]:has-text("Músicas")',
      '[role="tab"]:has-text("Musicas")',
      'button:has-text("Tracks")',
      'button:has-text("Songs")',
      'button:has-text("Canciones")',
    ], 1200).catch(() => false);
    await page.waitForTimeout(400);
  }
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
    if (!hasRequiredCookies(input.cookies)) {
      throw new Error('SPOTIFY_NOT_CONNECTED: incomplete cookies (sp_dc + sp_key required)');
    }
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
      if (!candidates.length) {
        const playedAny = await clickFirst(page, [
          'main [data-testid="play-button"]',
          '[data-testid="play-button"]',
          'main button[aria-label*="Play" i]',
        ], 1600);
        if (!playedAny) throw new Error('No tracks found on search page');
        result.ok = true;
        result.data = { name: query, artist: '' };
        return;
      }
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
