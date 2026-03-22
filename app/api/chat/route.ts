import { streamText, convertToModelMessages, type UIMessage, stepCountIs } from "ai"
import { anthropic } from "@ai-sdk/anthropic"
import { auth } from "@/lib/auth"
import { createTools } from "@/lib/tools"
import { getPreferences, checkActionLimit } from "@/lib/memory"
import { getSpotifySession, invalidateSpotifySession } from "@/lib/spotify-session"
import { createAgent } from "@/lib/spotify-agent"

export const runtime = "nodejs"
export const maxDuration = 60

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 })
  }

  const { messages }: { messages: UIMessage[] } = await req.json()
  const userId = session.user.id

  const limit = await checkActionLimit(userId)
  if (!limit.allowed) {
    return new Response(
      JSON.stringify({
        error:
          limit.reason === "hourly"
            ? "Rate limit: máximo 10 acciones por hora. Volvé en un momento."
            : "Límite mensual alcanzado. Actualizá a Pro para acciones ilimitadas.",
        plan: limit.plan,
      }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    )
  }

  const spotifyCookies = await getSpotifySession(userId)
  if (!spotifyCookies) {
    return new Response(
      JSON.stringify({
        error: "Spotify no conectado. Conectá tu cuenta primero.",
        code: "SPOTIFY_NOT_CONNECTED",
      }),
      { status: 402, headers: { "Content-Type": "application/json" } }
    )
  }

  const prefs = await getPreferences(userId)

  let agent
  try {
    agent = createAgent(spotifyCookies)
  } catch {
    return new Response(
      JSON.stringify({
        error: "Sesión de Spotify expirada. Reconectá tu cuenta.",
        code: "SPOTIFY_NOT_CONNECTED",
      }),
      { status: 402, headers: { "Content-Type": "application/json" } }
    )
  }

  const tools = createTools(agent, userId, prefs, async () => {
    // Called when agent detects session expired — marks DB so sidebar updates
    await invalidateSpotifySession(userId)
  })

  const modelMessages = await safeConvertMessages(messages)

  const result = streamText({
    model: anthropic("claude-sonnet-4-6"),
    system: buildSystemPrompt(prefs),
    messages: modelMessages,
    tools,
    stopWhen: stepCountIs(10),
  })

  return result.toUIMessageStreamResponse()
}

async function safeConvertMessages(messages: UIMessage[]) {
  try {
    return await convertToModelMessages(messages)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes("AI_MissingToolResultsError")) throw err

    // Recover from partial/in-flight tool calls left in client history.
    // Keep text and completed tool outputs only.
    const repaired = messages
      .map((m) => {
        const parts = m.parts.filter((part) => {
          if (isTextPart(part)) return true
          if (!isToolPart(part)) return true
          const state = String((part as { state?: unknown }).state ?? "")
          return state.startsWith("output-")
        })
        return { ...m, parts }
      })
      .filter((m) => m.parts.length > 0)

    return convertToModelMessages(repaired)
  }
}

function isTextPart(part: unknown): part is { type: "text"; text?: string } {
  return !!part && typeof part === "object" && (part as { type?: unknown }).type === "text"
}

function isToolPart(part: unknown): part is { type: string; state?: string } {
  if (!part || typeof part !== "object") return false
  const type = (part as { type?: unknown }).type
  return typeof type === "string" && type.startsWith("tool-")
}

function buildSystemPrompt(prefs: { blacklist: string[]; whitelist: string[]; notes: string[] }) {
  const lines = [
    "Sos Wavvy, un agente de música que controla Spotify en tiempo real para el usuario.",
    "Respondés en el idioma del usuario. Sos conciso y directo.",
    "Cuando el usuario pide música contextual (ej: 'para surfear', 'para concentrarme'), interpretás la intención y creás una playlist completa.",
    "Flujo para crear playlists: 1) Identificá mood/género/contexto 2) Usá get_tracks_by_mood o get_similar_artists para conseguir 20-50 candidatos 3) Llamá create_playlist con los mejores tracks.",
    "Si el usuario dice 'nunca más X' o 'recordá que...', guardás la preferencia con save_preference.",
    "Después de ejecutar una acción, confirmás brevemente lo que hiciste.",
    "Para búsquedas simples de un tema específico, usá search_spotify.",
    "Para poner a reproducir una canción específica, usá play_track. Ejemplos: 'pon X', 'escuchar X', 'play X'.",
    "Para pausar/reanudar, usá pause. Para saltar canción, usá next_track. Para ver qué suena, usá now_playing.",
  ]
  if (prefs.blacklist.length > 0) lines.push(`NUNCA sugerir ni incluir: ${prefs.blacklist.join(", ")}`)
  if (prefs.whitelist.length > 0) lines.push(`Favoritos del usuario: ${prefs.whitelist.join(", ")}`)
  if (prefs.notes.length > 0) lines.push(`Notas: ${prefs.notes.join("; ")}`)
  return lines.join("\n")
}
