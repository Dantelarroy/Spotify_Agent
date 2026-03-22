"use client"

import Image from "next/image"
import { signOut } from "next-auth/react"
import { Music2, LogOut, Crown, X, Waves, AlertCircle } from "lucide-react"
import { useEffect, useState } from "react"

interface SidebarClientProps {
  user: {
    name: string | null
    email: string | null
    image: string | null
  }
  plan: string
  blacklist: string[]
  whitelist: string[]
  spotifyConnected: boolean
}

export function SidebarClient({
  user,
  plan,
  blacklist,
  whitelist,
  spotifyConnected: initialConnected,
}: SidebarClientProps) {
  const [spotifyConnected, setSpotifyConnected] = useState(initialConnected)

  // Poll Spotify status every 10 seconds to detect disconnection in real time
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch("/api/spotify-status")
        const { connected } = await res.json()
        setSpotifyConnected(connected)
      } catch {
        // ignore
      }
    }
    const interval = setInterval(check, 10000)
    return () => clearInterval(interval)
  }, [])

  return (
    <aside className="w-[250px] flex-shrink-0 border-r border-white/10 flex flex-col bg-[#111] overflow-y-auto">
      {/* Logo */}
      <div className="p-4 border-b border-white/10">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-[#1db954]/20 border border-[#1db954]/30 flex items-center justify-center">
            <Music2 size={16} className="text-[#1db954]" />
          </div>
          <span className="font-bold text-[#1db954]">Wavvy</span>
        </div>
      </div>

      {/* Spotify status */}
      <div className="px-3 pt-3">
        {spotifyConnected ? (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#1db954]/10 border border-[#1db954]/20">
            <Waves size={14} className="text-[#1db954] flex-shrink-0" />
            <span className="text-xs text-[#1db954] font-medium">Spotify conectado</span>
            <span className="ml-auto w-2 h-2 rounded-full bg-[#1db954] animate-pulse" />
          </div>
        ) : (
          <a
            href="/connect-spotify"
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-orange-500/10 border border-orange-500/30 hover:bg-orange-500/20 transition-colors group"
          >
            <AlertCircle size={14} className="text-orange-400 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-orange-400 font-medium">Spotify desconectado</p>
              <p className="text-xs text-orange-400/60">Tap para reconectar</p>
            </div>
          </a>
        )}
      </div>

      {/* Memory panel */}
      <div className="px-4 py-3 flex-1">
        {blacklist.length > 0 && (
          <div className="mb-4">
            <p className="text-xs text-gray-500 mb-2 font-medium uppercase tracking-wider">
              Bloqueados
            </p>
            <div className="flex flex-wrap gap-1">
              {blacklist.map((item) => (
                <span
                  key={item}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-red-500/10 text-red-400 border border-red-500/20"
                >
                  <X size={10} />
                  {item}
                </span>
              ))}
            </div>
          </div>
        )}

        {whitelist.length > 0 && (
          <div className="mb-4">
            <p className="text-xs text-gray-500 mb-2 font-medium uppercase tracking-wider">
              Favoritos
            </p>
            <div className="flex flex-wrap gap-1">
              {whitelist.map((item) => (
                <span
                  key={item}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-[#1db954]/10 text-[#1db954] border border-[#1db954]/20"
                >
                  ♥ {item}
                </span>
              ))}
            </div>
          </div>
        )}

        {blacklist.length === 0 && whitelist.length === 0 && (
          <p className="text-xs text-gray-600 italic mt-2">
            Decime tus preferencias y las recordaré.
          </p>
        )}
      </div>

      {/* User section */}
      <div className="p-4 border-t border-white/10">
        {/* Plan badge */}
        <div className="flex items-center gap-2 mb-3">
          {plan === "pro" ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-yellow-500/10 text-yellow-400 border border-yellow-500/20 font-medium">
              <Crown size={10} />
              Pro
            </span>
          ) : (
            <a
              href="#pricing"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-white/5 text-gray-400 border border-white/10 hover:border-[#1db954]/30 hover:text-[#1db954] transition-colors"
            >
              Free · Upgrade
            </a>
          )}
        </div>

        {/* User info */}
        <div className="flex items-center gap-2 mb-3">
          {user.image ? (
            <Image
              src={user.image}
              alt={user.name ?? "User"}
              width={32}
              height={32}
              className="rounded-full"
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-[#1db954]/20 flex items-center justify-center text-[#1db954] text-sm font-medium">
              {(user.name ?? user.email ?? "U")[0].toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate">{user.name ?? "Usuario"}</p>
            <p className="text-xs text-gray-500 truncate">{user.email}</p>
          </div>
        </div>

        {/* Sign out */}
        <button
          onClick={() => signOut({ callbackUrl: "/" })}
          className="flex items-center gap-2 text-xs text-gray-500 hover:text-red-400 transition-colors w-full"
        >
          <LogOut size={12} />
          Cerrar sesión
        </button>
      </div>
    </aside>
  )
}
