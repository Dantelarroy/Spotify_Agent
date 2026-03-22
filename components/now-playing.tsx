"use client"

import { useEffect, useState, useCallback } from "react"
import Image from "next/image"
import { Play, Pause, SkipBack, SkipForward, Volume2 } from "lucide-react"
import { SpotifyPlaybackState } from "@/lib/spotify"

export function NowPlaying() {
  const [state, setState] = useState<SpotifyPlaybackState | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchCurrent = useCallback(async () => {
    try {
      const res = await fetch("/api/spotify/current")
      if (res.ok) {
        const data = await res.json()
        setState(data)
      }
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    fetchCurrent()
    const interval = setInterval(fetchCurrent, 5000)
    return () => clearInterval(interval)
  }, [fetchCurrent])

  const handleAction = async (action: string) => {
    if (loading) return
    setLoading(true)
    try {
      await fetch(`/api/spotify/${action}`, { method: "POST" })
      setTimeout(fetchCurrent, 500)
    } finally {
      setLoading(false)
    }
  }

  if (!state || !state.item) {
    return (
      <div className="px-4 py-3">
        <p className="text-xs text-gray-500 text-center">Nothing playing</p>
      </div>
    )
  }

  const { item, is_playing, progress_ms } = state
  const artist = item.artists.map((a) => a.name).join(", ")
  const albumArt = item.album?.images?.[2]?.url ?? item.album?.images?.[0]?.url
  const progressPct = item.duration_ms
    ? Math.round((progress_ms / item.duration_ms) * 100)
    : 0

  return (
    <div className="px-3 py-3 border border-white/10 rounded-lg bg-white/5 mx-3 mb-3">
      {/* Album art + track info */}
      <div className="flex items-center gap-3 mb-3">
        {albumArt ? (
          <Image
            src={albumArt}
            alt={item.album.name}
            width={40}
            height={40}
            className="rounded-md flex-shrink-0"
          />
        ) : (
          <div className="w-10 h-10 rounded-md bg-white/10 flex-shrink-0 flex items-center justify-center">
            <Volume2 size={16} className="text-gray-500" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white truncate leading-tight">
            {item.name}
          </p>
          <p className="text-xs text-gray-400 truncate">{artist}</p>
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-white/10 rounded-full h-1 mb-3">
        <div
          className="bg-[#1db954] h-1 rounded-full transition-all duration-1000"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-4">
        <button
          onClick={() => handleAction("previous")}
          disabled={loading}
          className="text-gray-400 hover:text-white transition-colors disabled:opacity-50"
          aria-label="Previous"
        >
          <SkipBack size={16} />
        </button>
        <button
          onClick={() => handleAction(is_playing ? "pause" : "play")}
          disabled={loading}
          className="w-8 h-8 rounded-full bg-[#1db954] hover:bg-[#1ed760] flex items-center justify-center text-black transition-colors disabled:opacity-50"
          aria-label={is_playing ? "Pause" : "Play"}
        >
          {is_playing ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
        </button>
        <button
          onClick={() => handleAction("next")}
          disabled={loading}
          className="text-gray-400 hover:text-white transition-colors disabled:opacity-50"
          aria-label="Next"
        >
          <SkipForward size={16} />
        </button>
      </div>
    </div>
  )
}
