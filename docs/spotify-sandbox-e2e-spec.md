# Spotify Sandbox E2E Spec (No Official API)

## Goal
Create Spotify playlists end-to-end through Spotify Web automation running inside Vercel Sandbox, without using the official Spotify API.

## Scope
- Uses `@vercel/sandbox` microVM.
- Uses Playwright inside sandbox runtime for playlist creation and track insertion.
- Uses Spotify Web session cookies stored per user.
- Explicitly fails when playlist is created but no tracks are added.

## Non-Goals
- No Spotify official API endpoints.
- No backend token exchange with Spotify OAuth API.

## Deterministic Contract
`create_playlist` is considered successful only if all are true:
1. A valid playlist URL is resolved.
2. At least one track was added (`trackCount > 0`) when input tracks are non-empty.
3. Playlist page contains at least one real track link (`finalTrackLinks > 0`).

If any condition fails, return operational error and never report success.

## Connection Contract
Manual connection must provide a full Cookie header from Spotify Web:
- Required minimum: `sp_dc` + `sp_key`
- `sp_dc` only is considered incomplete and may fail with missing library controls.

## Architecture
1. `POST /api/connect-spotify` stores cookies (`cookieHeader` parsing supported).
2. `create_playlist` tool calls `SpotifyAgent.createPlaylist`.
3. `SpotifyAgent` creates sandbox and executes Playwright flow:
   - open library playlists view
   - create playlist with multi-strategy UI heuristics
   - resolve created playlist id/url
   - add tracks by query from search tracks view
   - verify final playlist has track links
4. Returns `{ url, trackCount }` or throws `PLAYLIST_CREATE_FAILED:*`.

## Failure Taxonomy
- `SPOTIFY_NOT_CONNECTED:*`: session expired or incomplete cookies.
- `PLAYLIST_CREATE_FAILED:Could not click create playlist control`: create button path not found.
- `PLAYLIST_CREATE_FAILED:Could not navigate to playlist page`: playlist id not discovered.
- `PLAYLIST_CREATE_FAILED:No tracks were added to the created playlist`: deterministic empty-playlist guard.

## Observability
Use deployment logs:

```bash
npx vercel logs --follow --deployment <deployment-id>
```

Look for:
- `SPOTIFY_PW_RESULT=...`
- `phase` (`open_library`, `create_playlist`, `add_tracks`, etc.)
- `debug.trackFailures`
- `debug.finalTrackLinks`

## Acceptance Criteria
1. Given valid Spotify web cookies (`sp_dc` + `sp_key`), playlist creation returns URL and `trackCount >= 1`.
2. If Spotify UI changes and tracks cannot be added, system returns explicit error (never false success).
3. If cookies are incomplete, system returns `SPOTIFY_NOT_CONNECTED` guidance.
4. Production logs provide enough diagnostics to identify failing phase without reproducing locally.

## Operational Runbook
1. Verify branch/deploy:
   - `feat/vercel-sandbox-agent`
   - latest production deployment is aliased.
2. Connect Spotify via `/connect-spotify` using full cookie header.
3. Run a test command in chat: create playlist with 5 known songs.
4. If failed, inspect logs and classify by failure taxonomy.
5. Apply targeted fix in sandbox Playwright flow and redeploy.
