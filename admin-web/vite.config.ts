import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));
export default defineConfig({ root, plugins: [react()], build: { outDir: resolve(root, "../dist/admin-web"), emptyOutDir: true }, server: { port: 3200, proxy: { "/api": "http://localhost:3000" } } });
