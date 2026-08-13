import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { nitro } from "nitro/vite";

export default defineConfig({
  server: {
    port: 3000,
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    tanstackStart({
      srcDirectory: "src",
    }),
    viteReact(),
    nitro({
      // Vercel builds (VERCEL=1 is set by Vercel) emit the Build Output API
      // layout at .vercel/output. Local + Docker builds keep the default
      // node-server output at .output, which the Dockerfile and
      // `npm --prefix web run start` expect.
      ...(process.env.VERCEL
        ? {
            preset: "vercel" as const,
            // Live position reads (RPC + KeeperHub) can run long on cold
            // starts; the Hobby default maxDuration of 10s risks 504s.
            vercel: { functions: { maxDuration: 60 } },
          }
        : {}),
    }),
  ],
});
