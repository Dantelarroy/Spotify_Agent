import { Auth, setEnvDefaults } from "@auth/core"
import { authConfig } from "@/lib/auth"
import { NextRequest } from "next/server"

const AUTH_ORIGIN = (process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "")

async function buildRequest(req: NextRequest): Promise<Request> {
  const url = new URL(req.url)
  const target = new URL(AUTH_ORIGIN)
  url.protocol = target.protocol
  url.host = target.host
  const body = req.method !== "GET" && req.method !== "HEAD" ? await req.text() : null
  return new Request(url.toString(), {
    method: req.method,
    headers: req.headers,
    body,
  })
}

async function handler(req: NextRequest): Promise<Response> {
  try {
    const fixedReq = await buildRequest(req)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = { ...authConfig } as any
    setEnvDefaults(process.env, config)
    config.basePath = "/api/auth"

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await Auth(fixedReq, config) as any as Response
    const location = (res.headers as Headers).get?.("location") ?? ""
    console.log("[auth]", req.method, new URL(fixedReq.url).pathname, "→", (res as Response).status, location)
    return res
  } catch (e) {
    const msg = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)
    console.error("[auth] handler threw:", msg)
    return Response.json({ handlerError: msg }, { status: 500 })
  }
}

export { handler as GET, handler as POST }
