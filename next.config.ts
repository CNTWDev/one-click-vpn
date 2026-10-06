import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["ssh2", "pg"],
  // Permanent client download links also work on the API host; the Portal proxies the same paths.
  async rewrites() {
    return [{ source: "/download/:target*", destination: "/api/v1/client-releases/download/:target*" }];
  },
};

export default nextConfig;
