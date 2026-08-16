import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["openai", "better-sqlite3"],
};

export default nextConfig;
