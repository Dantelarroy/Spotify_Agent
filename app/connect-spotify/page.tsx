"use client"

import { Waves, Monitor } from "lucide-react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useState } from "react"

function ConnectContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const urlError = searchParams.get("error")

  const [state, setState] = useState<"idle" | "waiting" | "done" | "error">("idle")
  const [error, setError] = useState<string | null>(urlError)

  const handleConnect = async () => {
    setState("waiting")
    setError(null)

    try {
      const res = await fetch("/api/connect-spotify", { method: "POST" })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? "No se pudo iniciar la conexión.")
      }
      const { sessionId } = await res.json()

      // Poll until connected or error
      const poll = setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/connect-spotify?sid=${sessionId}`)
          const { status, error: capError } = await statusRes.json()

          if (status === "connected") {
            clearInterval(poll)
            setState("done")
            setTimeout(() => router.replace("/app"), 1200)
          } else if (status === "error") {
            clearInterval(poll)
            setState("error")
            setError(capError ?? "Error al conectar. Intentá de nuevo.")
          }
        } catch {
          clearInterval(poll)
          setState("error")
          setError("Error de red. Intentá de nuevo.")
        }
      }, 1500)

      // Safety timeout: 130 seconds
      setTimeout(() => {
        clearInterval(poll)
        if (state === "waiting") {
          setState("error")
          setError("Tiempo agotado. Volvé a intentarlo.")
        }
      }, 130000)
    } catch (err: unknown) {
      setState("error")
      setError(err instanceof Error ? err.message : "Error inesperado.")
    }
  }

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="w-16 h-16 rounded-2xl bg-[#1db954]/20 border border-[#1db954]/30 flex items-center justify-center mx-auto">
          <Waves size={32} className="text-[#1db954]" />
        </div>

        <div>
          <h1 className="text-2xl font-bold mb-2">Conectá tu cuenta de Spotify</h1>
          <p className="text-gray-400 text-sm">
            Wavvy abre una ventana del navegador donde podés iniciar sesión en Spotify. Solo lo hacés una vez.
          </p>
        </div>

        {error && (
          <div className="px-4 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
            {error}
          </div>
        )}

        {state === "idle" && (
          <button
            onClick={handleConnect}
            className="flex items-center justify-center gap-3 px-8 py-4 bg-[#1db954] hover:bg-[#1ed760] text-black font-bold rounded-full transition-all w-full"
          >
            <svg viewBox="0 0 24 24" className="w-6 h-6 fill-current" aria-hidden="true">
              <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
            </svg>
            Conectar con Spotify
          </button>
        )}

        {state === "waiting" && (
          <div className="space-y-4">
            <div className="px-6 py-4 rounded-xl bg-white/5 border border-[#1db954]/20 text-sm text-gray-300 flex items-start gap-3">
              <Monitor size={20} className="text-[#1db954] flex-shrink-0 mt-0.5" />
              <span>
                Abrimos una ventana del navegador — iniciá sesión en Spotify y volvé acá. Se detectará automáticamente cuando estés listo.
              </span>
            </div>
            <div className="flex items-center justify-center gap-2 text-gray-500 text-sm">
              <div className="w-4 h-4 border-2 border-[#1db954] border-t-transparent rounded-full animate-spin" />
              Esperando tu login...
            </div>
          </div>
        )}

        {state === "done" && (
          <div className="px-6 py-4 rounded-xl bg-[#1db954]/10 border border-[#1db954]/30 text-[#1db954] text-sm font-medium">
            ✓ Spotify conectado. Redirigiendo...
          </div>
        )}

        {state === "error" && (
          <button
            onClick={() => { setState("idle"); setError(null) }}
            className="flex items-center justify-center gap-3 px-8 py-4 bg-[#1db954] hover:bg-[#1ed760] text-black font-bold rounded-full transition-all w-full"
          >
            Intentar de nuevo
          </button>
        )}

        <Link href="/app" className="text-sm text-gray-600 hover:text-gray-400 transition-colors block">
          Volver al chat
        </Link>
      </div>
    </main>
  )
}

export default function ConnectSpotifyPage() {
  return (
    <Suspense>
      <ConnectContent />
    </Suspense>
  )
}
