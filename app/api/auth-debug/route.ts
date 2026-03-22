import { NextResponse } from "next/server"
import { authConfig } from "@/lib/auth"
import { setEnvDefaults } from "@auth/core"

export async function GET() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config = { ...authConfig } as any
  setEnvDefaults(process.env, config)
  config.basePath = "/api/auth"

  const result: Record<string, unknown> = {
    trustHost: config.trustHost,
    secretType: typeof config.secret,
    secretLength: typeof config.secret === "string" ? config.secret.length : Array.isArray(config.secret) ? config.secret.length : null,
    hasAdapter: !!config.adapter,
    sessionStrategy: config.session?.strategy,
    providers: config.providers?.map((p: { id?: string; type?: string }) => ({ id: p.id, type: p.type })),
    AUTH_SECRET_length: process.env.AUTH_SECRET?.length ?? 0,
    AUTH_URL: process.env.AUTH_URL,
  }
  return NextResponse.json(result)
}
