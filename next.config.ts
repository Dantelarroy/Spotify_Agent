import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  outputFileTracingIncludes: {
    "/api/chat": ["./scripts/pw/**/*.cjs"],
    "/api/chat/route": ["./scripts/pw/**/*.cjs"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
    ],
  },
};

export default nextConfig;
