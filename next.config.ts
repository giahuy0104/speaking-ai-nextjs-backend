import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: process.env.NEXT_OUTPUT_STANDALONE === "true" ? "standalone" : undefined,
  // Verify production builds without touching a running local dev checkout.
  distDir: process.env.AUDIO_TRANSLATION_ISOLATED_BUILD === "true" ? ".next-audio-check" : ".next",
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [],
      fallback: [
        {
          source: "/generated-audio/:fileName",
          destination: "/api/audio/cache/:fileName",
        },
      ],
    };
  },
  async headers() {
    return [
      {
        source: "/generated-audio/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
