import { tool } from "ai"
import { z } from "zod"
import type { SpotifyAgent } from "./spotify-agent"
import { savePreference, deletePreference, getPreferences } from "./memory"

const DEEZER_API = "https://api.deezer.com"

const MOOD_TO_GENRE: Record<string, number> = {
  pop: 132,
  rock: 152,
  electronic: 106,
  jazz: 129,
  "hip-hop": 116,
  "r&b": 165,
  metal: 464,
  classical: 98,
  reggae: 144,
  country: 84,
  indie: 122,
  alternative: 85,
  chill: 132,
  workout: 152,
  focus: 98,
  surf: 152,
  happy: 132,
  sad: 129,
  party: 132,
}

function normalize(s: string) {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
}

function isBlacklisted(name: string, blacklist: string[]): boolean {
  const n = normalize(name)
  return blacklist.some((b) => n.includes(normalize(b)))
}

function compactTrackQuery(name: string, artist: string): string {
  const cleanArtist = String(artist || "")
    .replace(/[()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const cleanName = String(name || "")
    // remove long/verbose suffixes that hurt Spotify matching
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\b(live|remaster(ed)?|version|mono|stereo|deluxe)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
  const shortTitle = cleanName.split(/[:\-|]/)[0]?.trim() || cleanName
  return `${cleanArtist} ${shortTitle}`.replace(/\s+/g, " ").trim().slice(0, 90)
}

async function deezerGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${DEEZER_API}${path}`)
    if (!res.ok) return null
    return res.json() as Promise<T>
  } catch {
    return null
  }
}

async function deezerSearchArtist(name: string): Promise<number | null> {
  const data = await deezerGet<{ data: Array<{ id: number; name: string }> }>(
    `/search/artist?q=${encodeURIComponent(name)}&limit=1`
  )
  return data?.data?.[0]?.id ?? null
}

function wrapSpotifyCall<T>(fn: () => Promise<T>, onExpired: () => Promise<void>): Promise<T> {
  return fn().catch(async (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    const apiErr = err as { json?: unknown; text?: string; response?: { status?: number; url?: string } }
    console.error("[wrapSpotifyCall] error:", msg)
    if (apiErr?.response?.status) {
      console.error("[wrapSpotifyCall] response:", {
        status: apiErr.response.status,
        url: apiErr.response.url,
      })
    }
    if (apiErr?.json) console.error("[wrapSpotifyCall] json:", JSON.stringify(apiErr.json).slice(0, 400))
    if (apiErr?.text) console.error("[wrapSpotifyCall] text:", String(apiErr.text).slice(0, 400))
    // Invalidate only when we have strong evidence that the session is dead.
    const sessionDead = [
      "SPOTIFY_NOT_CONNECTED",
      "redirected to login",
      "accounts.spotify.com",
      "anonymous token",
      "401",
      "missing sp_dc",
    ].some((marker) => msg.toLowerCase().includes(marker.toLowerCase()))

    if (sessionDead) {
      console.error("[wrapSpotifyCall] invalidating session")
      await onExpired()
      throw new Error("SPOTIFY_NOT_CONNECTED: " + msg)
    }

    // Preserve non-auth failures as operational errors, not auth disconnections.
    throw err instanceof Error ? err : new Error(msg)
  })
}

export function createTools(
  agent: SpotifyAgent,
  userId: string,
  prefs: { blacklist: string[]; whitelist: string[]; notes: string[] },
  onSessionExpired: () => Promise<void> = async () => {}
) {
  const { blacklist } = prefs

  return {
    search_spotify: tool({
      description: "Search for tracks on Spotify. Use for specific song/artist queries.",
      inputSchema: z.object({
        query: z.string().describe("Search query (song name, artist, etc.)"),
        limit: z.number().min(1).max(20).default(10),
      }),
      execute: async ({ query, limit }) => {
        const tracks = await wrapSpotifyCall(
          () => agent.searchTracks(query, limit),
          onSessionExpired
        )
        const filtered = tracks.filter(
          (t) => !isBlacklisted(t.name, blacklist) && !isBlacklisted(t.artist, blacklist)
        )
        return JSON.stringify(filtered)
      },
    }),

    create_playlist: tool({
      description:
        "Create a new playlist on Spotify with the given name, description, and tracks.",
      inputSchema: z.object({
        name: z.string().describe("Playlist name"),
        description: z.string().default("").describe("Playlist description"),
        tracks: z
          .array(z.object({ name: z.string(), artist: z.string() }))
          .describe("List of tracks to add"),
      }),
      execute: async ({ name, description, tracks }) => {
        const filtered = tracks.filter(
          (t) => !isBlacklisted(t.name, blacklist) && !isBlacklisted(t.artist, blacklist)
        )
        const trackQueries = filtered.map((t) => compactTrackQuery(t.name, t.artist))
        const result = await wrapSpotifyCall(
          () => agent.createPlaylist(name, description, trackQueries),
          onSessionExpired
        )
        if (trackQueries.length > 0 && result.trackCount <= 0) {
          throw new Error(
            "PLAYLIST_EMPTY: Playlist created but 0 tracks were added. Spotify Web UI automation could not match/add tracks."
          )
        }
        return JSON.stringify({
          message: `Creé la playlist "${name}" con ${result.trackCount} temas.`,
          url: result.url,
          tracks: filtered.slice(0, 5),
        })
      },
    }),

    get_similar_artists: tool({
      description:
        "Get artists similar to a given artist via Deezer. Great for expanding seed artists.",
      inputSchema: z.object({
        artist: z.string().describe("Artist name"),
        limit: z.number().min(1).max(20).default(10),
      }),
      execute: async ({ artist, limit }) => {
        const artistId = await deezerSearchArtist(artist)
        if (!artistId) return `Artist "${artist}" not found.`
        const data = await deezerGet<{ data: Array<{ name: string; nb_fan: number }> }>(
          `/artist/${artistId}/related?limit=${limit}`
        )
        if (!data?.data?.length) return `No similar artists found for "${artist}".`
        const artists = data.data
          .filter((a) => !isBlacklisted(a.name, blacklist))
          .map((a) => ({ name: a.name, fans: a.nb_fan }))
        return JSON.stringify(artists)
      },
    }),

    get_tracks_by_mood: tool({
      description:
        "Get top tracks for a mood/genre via Deezer charts. Moods: chill, workout, focus, sad, happy, surf, electronic, jazz, rock, pop, hip-hop, indie, party, etc.",
      inputSchema: z.object({
        mood: z.string().describe("Mood or genre"),
        limit: z.number().min(1).max(50).default(20),
      }),
      execute: async ({ mood, limit }) => {
        const genreId = MOOD_TO_GENRE[mood.toLowerCase()] ?? 132
        const data = await deezerGet<{ data: Array<{ title: string; artist: { name: string } }> }>(
          `/chart/${genreId}/tracks?limit=${limit}`
        )
        if (!data?.data?.length) {
          const fallback = await deezerGet<{ tracks: { data: Array<{ title: string; artist: { name: string } }> } }>(
            `/chart/0/tracks?limit=${limit}`
          )
          const tracks = (fallback?.tracks?.data ?? [])
            .filter((t) => !isBlacklisted(t.title, blacklist) && !isBlacklisted(t.artist.name, blacklist))
            .map((t) => ({ name: t.title, artist: t.artist.name }))
          return JSON.stringify(tracks)
        }
        const tracks = data.data
          .filter((t) => !isBlacklisted(t.title, blacklist) && !isBlacklisted(t.artist.name, blacklist))
          .map((t) => ({ name: t.title, artist: t.artist.name }))
        return JSON.stringify(tracks)
      },
    }),

    get_artist_top_tracks: tool({
      description: "Get top tracks for a specific artist via Deezer.",
      inputSchema: z.object({
        artist: z.string().describe("Artist name"),
        limit: z.number().min(1).max(20).default(10),
      }),
      execute: async ({ artist, limit }) => {
        const artistId = await deezerSearchArtist(artist)
        if (!artistId) return `Artist "${artist}" not found.`
        const data = await deezerGet<{ data: Array<{ title: string; artist: { name: string } }> }>(
          `/artist/${artistId}/top?limit=${limit}`
        )
        if (!data?.data?.length) return `No tracks found for "${artist}".`
        const tracks = data.data
          .filter((t) => !isBlacklisted(t.title, blacklist))
          .map((t) => ({ name: t.title, artist: t.artist.name }))
        return JSON.stringify(tracks)
      },
    }),

    save_preference: tool({
      description: "Save a user preference — blacklist, whitelist, or notes.",
      inputSchema: z.object({
        type: z.enum(["blacklist", "whitelist", "notes"]),
        value: z.string(),
      }),
      execute: async ({ type, value }) => {
        await savePreference(userId, type, value)
        const messages = {
          blacklist: `Got it. I'll never suggest "${value}" again.`,
          whitelist: `Added "${value}" to your favorites.`,
          notes: `Noted: "${value}"`,
        }
        return messages[type]
      },
    }),

    get_preferences: tool({
      description: "Get the user's saved preferences.",
      inputSchema: z.object({}),
      execute: async () => {
        const userPrefs = await getPreferences(userId)
        return JSON.stringify(userPrefs)
      },
    }),

    delete_preference: tool({
      description: "Remove a value from the user's preferences.",
      inputSchema: z.object({
        type: z.enum(["blacklist", "whitelist", "notes"]),
        value: z.string(),
      }),
      execute: async ({ type, value }) => {
        await deletePreference(userId, type, value)
        return `Removed "${value}" from your ${type}.`
      },
    }),

    play_track: tool({
      description:
        "Search for a song and immediately start playing it in Spotify Web Player. Use when the user says 'play X', 'pon X', 'escuchar X'.",
      inputSchema: z.object({
        query: z.string().describe("Song name and/or artist to search and play"),
      }),
      execute: async ({ query }) => {
        const result = await wrapSpotifyCall(
          () => agent.playTrack(query),
          onSessionExpired
        )
        return JSON.stringify({
          message: `Reproduciendo "${result.name}"${result.artist ? ` de ${result.artist}` : ""}.`,
          name: result.name,
          artist: result.artist,
        })
      },
    }),

    pause: tool({
      description:
        "Pause or resume playback in Spotify Web Player. Use when user says 'pause', 'stop', 'pausa', 'detener', 'continuar', 'resume'.",
      inputSchema: z.object({}),
      execute: async () => {
        await wrapSpotifyCall(() => agent.pausePlayback(), onSessionExpired)
        return "Reproducción pausada/reanudada."
      },
    }),

    next_track: tool({
      description:
        "Skip to the next song in Spotify. Use when user says 'next', 'siguiente', 'skip', 'saltar'.",
      inputSchema: z.object({}),
      execute: async () => {
        await wrapSpotifyCall(() => agent.skipToNext(), onSessionExpired)
        return "Avanzado a la siguiente canción."
      },
    }),

    now_playing: tool({
      description:
        "Check what's currently playing in Spotify. Use when user asks '¿qué suena?', 'what's playing', '¿qué está sonando?'.",
      inputSchema: z.object({}),
      execute: async () => {
        const info = await wrapSpotifyCall(() => agent.getNowPlaying(), onSessionExpired)
        if (!info) return "No hay nada reproduciéndose en este momento."
        return JSON.stringify({
          message: `Ahora suena: "${info.name}"${info.artist ? ` de ${info.artist}` : ""}.`,
          name: info.name,
          artist: info.artist,
        })
      },
    }),
  }
}
