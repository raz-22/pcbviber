import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const BFF = "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": { target: BFF, changeOrigin: false },
      "/mcp": { target: BFF, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
