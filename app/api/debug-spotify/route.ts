import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getSpotifySession } from "@/lib/spotify-session"

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const cookies = await getSpotifySession(session.user.id) as Array<{ name: string; value: string }> | null

  if (!cookies) {
    return NextResponse.json({ stage: "no_session", detail: "No valid session in DB (isValid=false or missing)" })
  }

  const cookieNames = cookies.map((c) => c.name)
  const spDc = cookies.find((c) => c.name === "sp_dc")

  if (!spDc) {
    return NextResponse.json({
      stage: "no_sp_dc",
      detail: "Session exists but sp_dc not in stored cookies",
      storedCookies: cookieNames,
    })
  }

  // Try the token endpoint
  let tokenResponse: Record<string, unknown> = {}
  let tokenStatus = 0
  try {
    const res = await fetch("https://open.spotify.com/api/token", {
      headers: {
        Cookie: `sp_dc=${spDc.value}`,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "application/json",
        "App-Platform": "WebPlayer",
        "Spotify-App-Version": "1.2.54.39.ga28a1a7e",
      },
    })
    tokenStatus = res.status
    tokenResponse = await res.json().catch(() => ({}))
  } catch (e) {
    return NextResponse.json({
      stage: "token_fetch_error",
      detail: e instanceof Error ? e.message : String(e),
      storedCookies: cookieNames,
      spDcPresent: true,
    })
  }

  return NextResponse.json({
    stage:
      tokenStatus === 200
        ? "success"
        : tokenStatus === 400 &&
          JSON.stringify(tokenResponse).includes("not permitted under the Spotify Developer Terms")
        ? "token_probe_blocked_policy"
        : "token_endpoint_failed",
    tokenStatus,
    isAnonymous: (tokenResponse as { isAnonymous?: boolean }).isAnonymous,
    hasAccessToken: !!(tokenResponse as { accessToken?: string }).accessToken,
    connectedLikely:
      tokenStatus === 200 ||
      (tokenStatus === 400 &&
        JSON.stringify(tokenResponse).includes("not permitted under the Spotify Developer Terms")),
    storedCookies: cookieNames,
    spDcPresent: true,
    // error detail if any
    tokenError: tokenStatus !== 200 ? tokenResponse : undefined,
  })
}
