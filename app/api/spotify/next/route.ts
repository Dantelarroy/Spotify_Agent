export const runtime = "nodejs"

export async function POST() {
  return new Response(
    JSON.stringify({ error: "This endpoint is deprecated. Use the Wavvy chat interface." }),
    { status: 410, headers: { "Content-Type": "application/json" } }
  )
}
