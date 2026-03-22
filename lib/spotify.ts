export interface SpotifyTrack {
  id: string
  name: string
  uri: string
  duration_ms: number
  artists: Array<{ id: string; name: string; uri: string }>
  album: {
    id: string
    name: string
    uri: string
    images: Array<{ url: string; width: number; height: number }>
  }
}

export interface SpotifyPlaybackState {
  is_playing: boolean
  progress_ms: number
  item: SpotifyTrack | null
  device: {
    id: string
    name: string
    type: string
    volume_percent: number
  }
  repeat_state: string
  shuffle_state: boolean
}

export interface SpotifyAudioFeatures {
  id: string
  energy: number
  valence: number
  tempo: number
  danceability: number
  acousticness: number
  instrumentalness: number
  speechiness: number
  loudness: number
  mode: number
  key: number
}

export class SpotifyClient {
  private token: string
  private baseUrl = "https://api.spotify.com/v1"

  constructor(token: string) {
    this.token = token
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    })

    if (res.status === 401) {
      throw new Error("SPOTIFY_TOKEN_EXPIRED")
    }

    if (res.status === 204 || res.status === 202) {
      return {} as T
    }

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Spotify API error ${res.status}: ${body}`)
    }

    if (res.headers.get("content-length") === "0") return {} as T

    return res.json() as Promise<T>
  }

  // ─── Playback ────────────────────────────────────────────────

  async getCurrentPlayback(): Promise<SpotifyPlaybackState | null> {
    try {
      const data = await this.request<SpotifyPlaybackState>("/me/player")
      return data?.item ? data : null
    } catch {
      return null
    }
  }

  async play(params: {
    uri?: string
    uris?: string[]
    contextUri?: string
    deviceId?: string
    offset?: number
  }): Promise<void> {
    const device = params.deviceId ? `?device_id=${params.deviceId}` : ""
    const body: Record<string, unknown> = {}

    if (params.contextUri) {
      body.context_uri = params.contextUri
      if (params.offset !== undefined) body.offset = { position: params.offset }
    } else if (params.uris) {
      body.uris = params.uris
    } else if (params.uri) {
      body.uris = [params.uri]
    }

    await this.request(`/me/player/play${device}`, {
      method: "PUT",
      body: JSON.stringify(body),
    })
  }

  async pause(deviceId?: string): Promise<void> {
    const device = deviceId ? `?device_id=${deviceId}` : ""
    await this.request(`/me/player/pause${device}`, { method: "PUT" })
  }

  async resume(deviceId?: string): Promise<void> {
    const device = deviceId ? `?device_id=${deviceId}` : ""
    await this.request(`/me/player/play${device}`, { method: "PUT" })
  }

  async skipNext(deviceId?: string): Promise<void> {
    const device = deviceId ? `?device_id=${deviceId}` : ""
    await this.request(`/me/player/next${device}`, { method: "POST" })
  }

  async skipPrevious(deviceId?: string): Promise<void> {
    const device = deviceId ? `?device_id=${deviceId}` : ""
    await this.request(`/me/player/previous${device}`, { method: "POST" })
  }

  async setVolume(volumePercent: number, deviceId?: string): Promise<void> {
    const device = deviceId ? `&device_id=${deviceId}` : ""
    await this.request(
      `/me/player/volume?volume_percent=${volumePercent}${device}`,
      { method: "PUT" }
    )
  }

  async queueTrack(uri: string, deviceId?: string): Promise<void> {
    const device = deviceId ? `&device_id=${deviceId}` : ""
    await this.request(
      `/me/player/queue?uri=${encodeURIComponent(uri)}${device}`,
      { method: "POST" }
    )
  }

  async getQueue(): Promise<{
    currently_playing: SpotifyTrack | null
    queue: SpotifyTrack[]
  }> {
    return this.request("/me/player/queue")
  }

  // ─── Devices ──────────────────────────────────────────────────

  async getDevices(): Promise<{
    devices: Array<{
      id: string
      name: string
      type: string
      is_active: boolean
    }>
  }> {
    return this.request("/me/player/devices")
  }

  // ─── Search ───────────────────────────────────────────────────

  async search(
    query: string,
    types: string[] = ["track"],
    limit = 10
  ): Promise<{
    tracks?: { items: SpotifyTrack[] }
    playlists?: {
      items: Array<{
        id: string
        name: string
        uri: string
        description: string
      }>
    }
    artists?: { items: Array<{ id: string; name: string; uri: string }> }
    albums?: {
      items: Array<{
        id: string
        name: string
        uri: string
        artists: { name: string }[]
      }>
    }
  }> {
    const q = encodeURIComponent(query)
    const t = types.join(",")
    return this.request(`/search?q=${q}&type=${t}&limit=${limit}`)
  }

  // ─── History & Catalog ────────────────────────────────────────

  async getRecentlyPlayed(
    limit = 20,
    after?: number
  ): Promise<{
    items: Array<{ track: SpotifyTrack; played_at: string }>
  }> {
    const qs = new URLSearchParams({ limit: String(limit) })
    if (after) qs.set("after", String(after))
    return this.request(`/me/player/recently-played?${qs.toString()}`)
  }

  async getTopItems(
    type: "tracks" | "artists",
    timeRange: "short_term" | "medium_term" | "long_term" = "medium_term",
    limit = 20
  ): Promise<{ items: SpotifyTrack[] }> {
    return this.request(
      `/me/top/${type}?time_range=${timeRange}&limit=${limit}`
    )
  }

  async getNewReleases(limit = 20): Promise<{
    albums: {
      items: Array<{
        id: string
        name: string
        uri: string
        artists: { name: string }[]
        release_date: string
      }>
    }
  }> {
    return this.request(`/browse/new-releases?limit=${limit}`)
  }

  // ─── Audio Features ───────────────────────────────────────────

  async getAudioFeatures(trackId: string): Promise<SpotifyAudioFeatures> {
    return this.request(`/audio-features/${trackId}`)
  }

  // ─── Playlists ────────────────────────────────────────────────

  async getUserPlaylists(limit = 20): Promise<{
    items: Array<{
      id: string
      name: string
      uri: string
      tracks: { total: number }
    }>
  }> {
    return this.request(`/me/playlists?limit=${limit}`)
  }

  async createPlaylist(
    userId: string,
    name: string,
    description = "",
    isPublic = false
  ): Promise<{ id: string; uri: string; name: string }> {
    return this.request(`/users/${userId}/playlists`, {
      method: "POST",
      body: JSON.stringify({ name, description, public: isPublic }),
    })
  }

  async addTracksToPlaylist(
    playlistId: string,
    uris: string[]
  ): Promise<void> {
    await this.request(`/playlists/${playlistId}/tracks`, {
      method: "POST",
      body: JSON.stringify({ uris }),
    })
  }

  async getMe(): Promise<{
    id: string
    display_name: string
    email: string
  }> {
    return this.request("/me")
  }
}

