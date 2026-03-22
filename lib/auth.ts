import NextAuth from "next-auth"
import GoogleProvider from "next-auth/providers/google"
import { PrismaAdapter } from "@auth/prisma-adapter"
import { prisma } from "./db"
import type { JWT } from "next-auth/jwt"

const providers = [
  GoogleProvider({
    clientId: process.env.AUTH_GOOGLE_ID!,
    clientSecret: process.env.AUTH_GOOGLE_SECRET!,
  }),
]

// Only add email provider if EMAIL_SERVER is configured
if (process.env.EMAIL_SERVER) {
  // Dynamic require to avoid top-level import throwing when EMAIL_SERVER is unset
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const EmailProvider = require("next-auth/providers/nodemailer").default
  providers.push(
    EmailProvider({
      server: process.env.EMAIL_SERVER,
      from: process.env.EMAIL_FROM ?? "noreply@wavvy.app",
    })
  )
}

export const authConfig = {
  trustHost: true,
  adapter: PrismaAdapter(prisma),
  providers,
  session: { strategy: "jwt" as const },
  cookies: {
    pkceCodeVerifier: {
      name: "authjs.pkce.code_verifier",
      options: {
        httpOnly: true,
        sameSite: "lax" as const,
        path: "/",
        secure: true,
      },
    },
  },
  callbacks: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async jwt(params: any) {
      const { token, user } = params
      // On first sign-in, user object is available — persist id into token
      if (user?.id) {
        token.sub = user.id
        token.userId = user.id
      }
      return token
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async session(params: any) {
      const { session, token }: { session: any; token: JWT } = params
      if (session.user) {
        let id: string | undefined = token.userId ?? token.sub ?? undefined
        // Fallback: look up by email (always present with Google OAuth)
        if (!id && session.user.email) {
          const dbUser = await prisma.user.findUnique({
            where: { email: session.user.email },
            select: { id: true },
          })
          id = dbUser?.id
        }
        if (id) session.user.id = id
      }
      return session
    },
  },
  pages: {
    signIn: "/",
    verifyRequest: "/verify-email",
  },
}

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig)
