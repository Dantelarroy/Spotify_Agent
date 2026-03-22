import { NextRequest, NextResponse } from "next/server"

const DEEZER_API = "https://api.deezer.com"

const MOOD_TO_GENRE: Record<string, number> = {
  chill: 132, workout: 152, focus: 98, sad: 129, happy: 132,
  sleep: 98, surf: 152, jazz: 129, electronic: 106, rock: 152,
  "90s": 132, indie: 122, party: 132, "hip-hop": 116,
}

const MOOD_KEYWORDS: Record<string, string[]> = {
  chill: ["chill", "relajado", "relax", "tranquilo"],
  workout: ["gym", "workout", "ejercicio", "energía", "correr", "running"],
  focus: ["concentrar", "focus", "trabajar", "código", "estudiar", "study"],
  sad: ["triste", "sad", "melancólico", "llorar"],
  happy: ["feliz", "happy", "alegre", "fiesta", "party"],
  sleep: ["dormir", "sleep", "calma"],
  surf: ["surf", "playa", "beach", "verano", "summer"],
  jazz: ["jazz"],
  electronic: ["electrónica", "electronic", "techno", "house"],
  rock: ["rock"],
  "90s": ["90s", "90"],
  indie: ["indie"],
}

export async function POST(req: NextRequest) {
  try {
    const { text, limit = 20 } = await req.json()
    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "text field required" }, { status: 400 })
    }

    const lowerText = text.toLowerCase()
    let detectedMood = "chill"
    for (const [mood, keywords] of Object.entries(MOOD_KEYWORDS)) {
      if (keywords.some((kw) => lowerText.includes(kw))) {
        detectedMood = mood
        break
      }
    }

    const genreId = MOOD_TO_GENRE[detectedMood] ?? 132
    const res = await fetch(`${DEEZER_API}/chart/${genreId}/tracks?limit=${limit}`)
    const data = res.ok ? await res.json() : null

    interface DeezerTrack { title: string; artist: { name: string } }

    const tracks = (data?.data as DeezerTrack[] | undefined ?? []).map((t) => ({
      name: t.title,
      artist: t.artist.name,
      searchQuery: `${t.title} ${t.artist.name}`,
    }))

    return NextResponse.json({ text, detectedMood, tracks, total: tracks.length })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
