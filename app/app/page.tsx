"use client"

import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport, isTextUIPart, isToolUIPart } from "ai"
import { useRef, useEffect, useState } from "react"
import { Send, Music2, Loader2, Square, Waves } from "lucide-react"
import Link from "next/link"

const SUGGESTED_PROMPTS = [
  "Poneme algo para concentrarme",
  "Haceme una playlist de gym con 15 temas",
  "Música para surfear, 90 minutos relajado",
  "Algo para el domingo a la tarde",
]

const TOOL_LABELS: Record<string, string> = {
  search_spotify: "buscando en Spotify",
  create_playlist: "creando playlist",
  get_similar_artists: "expandiendo artistas similares",
  get_tracks_by_mood: "descubriendo tracks por mood",
  get_artist_top_tracks: "cargando top tracks del artista",
  save_preference: "guardando preferencia",
  get_preferences: "cargando preferencias",
  delete_preference: "eliminando preferencia",
}

export default function ChatPage() {
  const [spotifyConnected, setSpotifyConnected] = useState<boolean | null>(null)

  // Check Spotify connection status on mount
  useEffect(() => {
    fetch("/api/spotify-status")
      .then((r) => r.json())
      .then((d) => setSpotifyConnected(d.connected))
      .catch(() => setSpotifyConnected(false))
  }, [])

  const { messages, sendMessage, status, error, stop } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  })

  const [input, setInput] = useState("")
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const isLoading = status === "submitted" || status === "streaming"

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault()
    const trimmed = input.trim()
    if (!trimmed || isLoading) return
    sendMessage({ text: trimmed })
    setInput("")
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handlePromptClick = (prompt: string) => {
    setInput(prompt)
    inputRef.current?.focus()
  }

  const isSpotifyError = error?.message?.includes("SPOTIFY_NOT_CONNECTED") ||
    error?.message?.includes("402") ||
    error?.message?.includes("Spotify no conectado")

  // Not connected state
  if (spotifyConnected === false) {
    return (
      <div className="flex flex-col h-full items-center justify-center px-6 text-center gap-6">
        <div className="w-16 h-16 rounded-2xl bg-[#1db954]/20 border border-[#1db954]/30 flex items-center justify-center">
          <Waves size={32} className="text-[#1db954]" />
        </div>
        <div>
          <h2 className="text-xl font-bold mb-2">Conectá tu cuenta de Spotify</h2>
          <p className="text-gray-400 text-sm max-w-sm">
            Wavvy necesita acceso a tu Spotify para crear playlists. Solo lo hacés una vez.
          </p>
        </div>
        <Link
          href="/connect-spotify"
          className="px-8 py-3 bg-[#1db954] hover:bg-[#1ed760] text-black font-bold rounded-full transition-all"
        >
          Conectar Spotify
        </Link>
      </div>
    )
  }

  // Loading connection status
  if (spotifyConnected === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="w-6 h-6 border-2 border-[#1db954] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-8 pb-20">
            <div className="text-center">
              <div className="w-16 h-16 rounded-2xl bg-[#1db954]/20 border border-[#1db954]/30 flex items-center justify-center mx-auto mb-4">
                <Music2 size={32} className="text-[#1db954]" />
              </div>
              <h2 className="text-xl font-bold mb-2">¿Qué querés escuchar?</h2>
              <p className="text-gray-400 text-sm">
                Describí el momento. Wavvy arma la playlist en tu Spotify.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-lg w-full">
              {SUGGESTED_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => handlePromptClick(prompt)}
                  className="text-left px-4 py-3 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 hover:border-[#1db954]/30 text-sm text-gray-300 hover:text-white"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) => (
          <div key={message.id} className="space-y-1">
            {message.parts.map((part, partIndex) => {
              if (isToolUIPart(part)) {
                const toolName = part.type.replace("tool-", "")
                const label = TOOL_LABELS[toolName] ?? toolName
                const isDone = part.state === "output-available" || part.state === "output-error" || part.state === "output-denied"
                const errorText =
                  part.state === "output-error" && typeof (part as unknown as { errorText?: unknown }).errorText === "string"
                    ? ((part as unknown as { errorText: string }).errorText)
                    : null
                return (
                  <div key={partIndex} className="py-0.5 px-2">
                    <div className="flex items-center gap-2 text-xs text-gray-500">
                      {!isDone ? (
                        <Loader2 size={10} className="animate-spin text-[#1db954] flex-shrink-0" />
                      ) : part.state === "output-error" ? (
                        <span className="text-red-400 flex-shrink-0">✕</span>
                      ) : (
                        <span className="text-[#1db954] flex-shrink-0">✓</span>
                      )}
                      <span className={isDone ? "text-gray-600" : "text-gray-400"}>
                        {isDone ? label : `${label}...`}
                      </span>
                    </div>
                    {errorText && (
                      <div className="mt-1 text-xs text-red-400/90">
                        {errorText}
                      </div>
                    )}
                  </div>
                )
              }
              if (isTextUIPart(part) && part.text) {
                return (
                  <div key={partIndex} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[80%] px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                      message.role === "user"
                        ? "bg-[#1db954] text-black font-medium rounded-br-sm"
                        : "bg-white/10 text-gray-100 rounded-bl-sm"
                    }`}>
                      {part.text}
                    </div>
                  </div>
                )
              }
              return null
            })}
          </div>
        ))}

        {status === "submitted" && (
          <div className="flex justify-start">
            <div className="bg-white/10 px-4 py-3 rounded-2xl rounded-bl-sm">
              <div className="flex gap-1">
                {[0, 150, 300].map((delay) => (
                  <span key={delay} className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: `${delay}ms` }} />
                ))}
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="flex justify-center">
            <div className="px-4 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error.message?.includes("429")
                ? "Límite alcanzado. Upgrade a Pro para acciones ilimitadas."
                : isSpotifyError
                ? <span>Spotify desconectado. <Link href="/connect-spotify" className="underline">Reconectá tu cuenta</Link>.</span>
                : "Error al conectar. Intentá de nuevo."}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="border-t border-white/10 p-4 bg-[#111]">
        <form onSubmit={handleSubmit} className="flex gap-3 max-w-4xl mx-auto">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describí el momento... (Enter para enviar)"
            rows={1}
            className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#1db954]/50 resize-none min-h-[48px] max-h-[120px] overflow-y-auto"
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement
              target.style.height = "auto"
              target.style.height = `${Math.min(target.scrollHeight, 120)}px`
            }}
          />
          {isLoading ? (
            <button type="button" onClick={stop} className="w-12 h-12 rounded-xl bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 flex items-center justify-center flex-shrink-0">
              <Square size={16} className="text-red-400" />
            </button>
          ) : (
            <button type="submit" disabled={!input.trim()} className="w-12 h-12 rounded-xl bg-[#1db954] hover:bg-[#1ed760] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center flex-shrink-0">
              <Send size={18} className="text-black" />
            </button>
          )}
        </form>
        <p className="text-center text-xs text-gray-700 mt-2">Wavvy puede cometer errores. Verificá lo que reproduce.</p>
      </div>
    </div>
  )
}
