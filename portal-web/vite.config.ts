import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root,
  publicDir: resolve(root, "../admin-web/public"),
  plugins: [react()],
  build: { outDir: resolve(root, "../dist/portal-web"), emptyOutDir: true },
  server: { port: 3100, proxy: { "/api": "http://localhost:3000" } },
});
