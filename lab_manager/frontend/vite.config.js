import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let gitHash = "dev";
try {
  gitHash = execSync("git rev-parse --short HEAD").toString().trim();
} catch (_) {}

const buildDate = new Date().toISOString().slice(0, 10);

let appVersion = "1.1.0";
try {
  appVersion = readFileSync(resolve(__dirname, "../backend/version.txt"), "utf-8").trim();
} catch (_) {}

export default defineConfig({
  define: {
    __BUILD_VERSION__: JSON.stringify(`${gitHash} · ${buildDate}`),
    __APP_VERSION__:   JSON.stringify(appVersion),
  },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8000", changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/__tests__/setup.js",
  },
});
