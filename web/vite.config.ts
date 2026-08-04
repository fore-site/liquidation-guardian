import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dashboard talks only to the local API server (which holds the KeeperHub
// key). Proxy /api there in dev so the browser never needs a cross-origin call
// and never sees a credential.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
