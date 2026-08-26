import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@grc/contracts",
    "@grc/review-core",
    "@grc/rules-engine",
    "@grc/retrieval",
    "@grc/providers",
    "@grc/review-store",
    "@grc/web-evidence",
  ],
  serverExternalPackages: ["openai", "better-sqlite3"],
};

export default nextConfig;
