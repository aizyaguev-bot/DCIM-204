import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "child_process";

let gitHash = "dev";
try {
  gitHash = execSync("git rev-parse --short HEAD").toString().trim();
} catch (_) {}

const buildDate = new Date().toISOString().slice(0, 10);

export default defineConfig({
  define: {
    __BUILD_VERSION__: JSON.stringify(`${gitHash} · ${buildDate}`),
  },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8000", changeOrigin: true },
    },
  },
});
