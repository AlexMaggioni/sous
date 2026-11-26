import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// While building, the dev server sends /api to a running `sous serve`. Start the server with
// SOUS_SERVE_TOKEN=dev, then this one with SOUS_TOKEN=dev, and the proxy carries the token.
const sous = process.env.SOUS_SERVE_URL ?? "http://127.0.0.1:4317";
const token = process.env.SOUS_TOKEN;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative asset paths, so sous serve can hand out dist/ from any folder.
  base: "./",
  build: { outDir: "dist", target: "es2022", sourcemap: true },
  server: {
    port: 5199,
    strictPort: true,
    proxy: { "/api": { target: sous, changeOrigin: true, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) } },
  },
  preview: { port: 5198, strictPort: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
