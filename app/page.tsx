"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useSession, signIn } from "next-auth/react"
import { Waves, Zap, Brain, Shield } from "lucide-react"

const EXAMPLE_CONVERSATIONS = [
  {
    user: "Salgo de surfear, poneme algo con energía pero relajado, 90 minutos",
    agent: "Creando 'Post-Surf Stoke 🌊' — 22 tracks · 91 min",
  },
  {
    user: "Estoy triste, necesito algo que me acompañe sin deprimirme más",
    agent: "Armando 'Gentle Company ♥' — 18 tracks seleccionados",
  },
  {
    user: "Trabajo con código, 2 horas de concentración sin letra",
    agent: "Playlist 'Deep Focus ⚡' lista en tu Spotify",
  },
]

export default function HomePage() {
  const { data: session, status } = useSession()
  const router = useRouter()

  useEffect(() => {
    if (status === "authenticated" && session) router.replace("/app")
  }, [status, session, router])

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-white">
      {/* Hero */}
      <section className="flex flex-col items-center justify-center min-h-screen px-6 text-center relative overflow-hidden">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(29,185,84,0.05) 0%, transparent 70%)",
          }}
        />

        {/* Logo */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-14 h-14 rounded-2xl bg-[#1db954]/20 border border-[#1db954]/30 flex items-center justify-center">
            <Waves size={28} className="text-[#1db954]" />
          </div>
          <span className="text-4xl font-bold text-[#1db954] tracking-tight">Wavvy</span>
        </div>

        <p className="text-gray-500 text-sm mb-6 tracking-widest uppercase">
          El agente conversacional para Spotify
        </p>

        <h1 className="text-4xl md:text-6xl font-bold mb-4 max-w-3xl leading-tight">
          Describís el momento.{" "}
          <span className="text-[#1db954]">Wavvy pone la música.</span>
        </h1>
        <p className="text-gray-400 text-lg mb-10 max-w-lg">
          Ninguna app de música entiende contexto. Wavvy sí. Escribís en lenguaje natural y tu
          playlist aparece directo en Spotify.
        </p>

        {/* Conversation preview */}
        <div className="w-full max-w-lg mb-10 space-y-4">
          {EXAMPLE_CONVERSATIONS.map((conv, i) => (
            <div key={i} className="space-y-2">
              <div className="flex justify-end">
                <div className="px-4 py-2.5 rounded-2xl rounded-br-sm bg-[#1db954] text-black font-medium text-sm max-w-xs text-left">
                  {conv.user}
                </div>
              </div>
              <div className="flex justify-start">
                <div className="px-4 py-2.5 rounded-2xl rounded-bl-sm bg-white/10 text-gray-300 text-sm max-w-xs text-left">
                  {conv.agent}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* CTA */}
        <button
          onClick={() => signIn("google", { callbackUrl: "/app" })}
          className="flex items-center gap-3 px-8 py-4 bg-[#1db954] hover:bg-[#1ed760] text-black font-bold rounded-full transition-all transform hover:scale-105 shadow-lg shadow-[#1db954]/25 text-lg"
          aria-label="Empezar gratis"
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden="true">
            <path
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              fill="#4285F4"
            />
            <path
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              fill="#34A853"
            />
            <path
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              fill="#FBBC05"
            />
            <path
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              fill="#EA4335"
            />
          </svg>
          Empezar gratis — Continuar con Google
        </button>
        <p className="text-gray-600 text-sm mt-3">5 playlists gratis · Sin tarjeta de crédito</p>
      </section>

      {/* How it works */}
      <section className="py-20 px-6 border-t border-white/5">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-2xl font-bold text-center mb-4">Cómo funciona</h2>
          <p className="text-gray-400 text-center mb-12 max-w-md mx-auto">
            Sin depender de los endpoints de Spotify (deprecados en 2024). Wavvy controla Spotify
            como un humano.
          </p>
          <div className="grid md:grid-cols-3 gap-6">
            {[
              {
                icon: Zap,
                title: "Describís el contexto",
                desc: "Le contás a Wavvy qué necesitás. Mood, actividad, duración. Nada de búsquedas manuales.",
              },
              {
                icon: Brain,
                title: "IA interpreta y descubre",
                desc: "Claude entiende la intención. Last.fm expande con artistas similares. 50+ candidatos analizados.",
              },
              {
                icon: Shield,
                title: "Playlist en tu Spotify",
                desc: "Wavvy crea la playlist directamente en tu cuenta. Sin tocar la API oficial deprecada.",
              },
            ].map(({ icon: Icon, title, desc }) => (
              <div
                key={title}
                className="p-6 rounded-xl border border-white/10 bg-white/5 hover:border-[#1db954]/30 transition-colors"
              >
                <div className="w-10 h-10 rounded-lg bg-[#1db954]/20 flex items-center justify-center mb-4">
                  <Icon size={20} className="text-[#1db954]" />
                </div>
                <h3 className="font-semibold mb-2">{title}</h3>
                <p className="text-gray-400 text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="py-20 px-6 border-t border-white/5" id="pricing">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-2xl font-bold text-center mb-4">Precios</h2>
          <p className="text-gray-400 text-center mb-12">Empezá gratis. Escalá cuando quieras.</p>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="p-6 rounded-xl border border-white/10 bg-white/5">
              <h3 className="text-xl font-bold mb-1">Free</h3>
              <div className="text-3xl font-bold mb-4">
                $0<span className="text-sm font-normal text-gray-400">/mes</span>
              </div>
              <ul className="space-y-2 text-sm text-gray-300 mb-6">
                {[
                  "5 playlists por mes",
                  "Mood detection con IA",
                  "Historial de preferencias",
                  "Hasta 10 acciones/hora",
                ].map((f) => (
                  <li key={f} className="flex items-center gap-2">
                    <span className="text-[#1db954]">✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              <button
                onClick={() => signIn("google", { callbackUrl: "/app" })}
                className="w-full py-2.5 rounded-lg border border-[#1db954] text-[#1db954] hover:bg-[#1db954]/10 transition-colors font-medium text-sm"
              >
                Empezar gratis
              </button>
            </div>
            <div className="p-6 rounded-xl border border-[#1db954]/50 bg-[#1db954]/5 relative">
              <div className="absolute top-4 right-4 text-xs bg-[#1db954] text-black px-2 py-0.5 rounded-full font-bold">
                POPULAR
              </div>
              <h3 className="text-xl font-bold mb-1">Pro</h3>
              <div className="text-3xl font-bold mb-4">
                $9<span className="text-sm font-normal text-gray-400">/mes</span>
              </div>
              <ul className="space-y-2 text-sm text-gray-300 mb-6">
                {[
                  "Playlists ilimitadas",
                  "Memoria persistente",
                  "Hasta 10 acciones/hora",
                  "Soporte prioritario",
                  "Todas las features de Free",
                ].map((f) => (
                  <li key={f} className="flex items-center gap-2">
                    <span className="text-[#1db954]">∞</span>
                    {f}
                  </li>
                ))}
              </ul>
              <button
                onClick={() => signIn("google", { callbackUrl: "/app" })}
                className="w-full py-2.5 rounded-lg bg-[#1db954] hover:bg-[#1ed760] text-black font-bold transition-colors text-sm"
              >
                Empezar con Pro
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 px-6 border-t border-white/5 text-center text-gray-600 text-sm">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Waves size={16} className="text-[#1db954]" />
          <span className="text-[#1db954] font-semibold">Wavvy</span>
        </div>
        <p>No afiliado con Spotify AB. Wavvy controla tu cuenta de Spotify de forma segura.</p>
      </footer>
    </main>
  )
}
