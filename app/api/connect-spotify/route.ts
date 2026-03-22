import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { saveSpotifySession } from "@/lib/spotify-session"
import { chromium, type Browser, type BrowserContext } from "playwright"

interface CaptureSession {
  browser: Browser
  context: BrowserContext
  userId: string
  status: "pending" | "connected" | "error"
  error?: string
}

// In-memory store for active capture sessions
const captureSessions = new Map<string, CaptureSession>()

// POST: Launch Playwright browser for Spotify login capture
export async function POST() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const sessionId = crypto.randomUUID()
  const userId = session.user.id

  let browser: Browser
  let context: BrowserContext

  try {
    browser = await chromium.launch({
      headless: false,
      args: ["--window-size=1024,700", "--window-position=100,100"],
    })

    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1024, height: 700 },
    })

    const captureSession: CaptureSession = {
      browser,
      context,
      userId,
      status: "pending",
    }
    captureSessions.set(sessionId, captureSession)

    const page = await context.newPage()

    // Watch for successful login and sp_dc capture
    ;(async () => {
      try {
        // Start at open.spotify.com — it redirects to login automatically.
        // This ensures sp_dc is set by the Web Player after login, not just accounts.spotify.com.
        await page.goto("https://open.spotify.com", {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        })

        // Wait up to 2 minutes for user to log in and land back on open.spotify.com
        await page.waitForURL(
          (url) => url.hostname === "open.spotify.com",
          { timeout: 120000 }
        )

        // Poll for sp_dc — the Web Player JS sets it asynchronously after page load.
        // Can take 5-20s depending on Spotify's initialization flow.
        let spDc: { name: string; value: string } | undefined
        const deadline = Date.now() + 30000
        while (!spDc && Date.now() < deadline) {
          await page.waitForTimeout(1000)
          const cookies = await context.cookies()
          spDc = cookies.find((c) => c.name === "sp_dc")
          console.log("[connect-spotify] polling cookies:", cookies.map((c) => c.name).join(", "))
        }

        if (!spDc) {
          captureSession.status = "error"
          captureSession.error = "No se encontró sp_dc. Asegurate de iniciar sesión en el Web Player y esperar que cargue la música."
          browser.close().catch(() => {})
          captureSessions.delete(sessionId)
          return
        }

        // Re-capture all cookies after sp_dc confirmed present
        const cookies = await context.cookies()

        // Save encrypted session to DB
        await saveSpotifySession(userId, cookies)
        captureSession.status = "connected"

        // Close browser after 3 seconds
        setTimeout(() => {
          browser.close().catch(() => {})
          captureSessions.delete(sessionId)
        }, 3000)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error("[connect-spotify] capture failed:", msg)
        const s = captureSessions.get(sessionId)
        if (s) {
          s.status = "error"
          s.error = msg.includes("Timeout")
            ? "Tiempo agotado. Volvé a intentarlo."
            : "Error al capturar la sesión."
        }
        browser.close().catch(() => {})
      }
    })()

    return NextResponse.json({ sessionId })
  } catch (err) {
    console.error("[connect-spotify] launch failed:", err)
    return NextResponse.json({ error: "No se pudo abrir el navegador." }, { status: 500 })
  }
}

// GET: Poll status of a capture session
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sid")
  if (!sessionId) {
    return NextResponse.json({ error: "Missing sid" }, { status: 400 })
  }

  const capture = captureSessions.get(sessionId)
  if (!capture) {
    // Session might have completed and been cleaned up
    const authSession = await auth()
    if (!authSession?.user?.id) {
      return NextResponse.json({ status: "error", error: "Session not found" })
    }
    // Check DB — if connected it was cleaned up after success
    const { hasSpotifySession } = await import("@/lib/spotify-session")
    const connected = await hasSpotifySession(authSession.user.id)
    return NextResponse.json({ status: connected ? "connected" : "error" })
  }

  return NextResponse.json({
    status: capture.status,
    error: capture.error,
  })
}
