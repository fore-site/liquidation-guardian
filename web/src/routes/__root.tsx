/// <reference types="vite/client" />
import { QueryClientProvider } from "@tanstack/react-query";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import * as React from "react";
// Side-effect import: Tailwind/Vite emits the stylesheet into the bundle
// (avoiding the ?url asset-hash desync between the SSR chunk and emitted CSS).
import "../styles.css";
import { ErrorPage, NotFoundPage } from "../components/ErrorPages.js";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        title: "Liquidation Guardian — Never get liquidated",
      },
      {
        name: "description",
        content:
          "An AI agent that keeps your Aave borrow position safe from liquidation — deciding the cheapest fix, then executing it onchain through KeeperHub.",
      },
      { name: "theme-color", content: "#000000" },
      { property: "og:title", content: "Liquidation Guardian — Never get liquidated" },
      {
        property: "og:description",
        content:
          "An event-driven watcher tracks your Aave health factor, an LLM picks the cheapest fix, and KeeperHub executes it onchain — simulated first, never blind.",
      },
      { property: "og:type", content: "website" },
    ],
    links: [
      // Geist + Geist Mono (Google Fonts CDN; display=swap avoids FOUT).
      {
        rel: "preconnect",
        href: "https://fonts.googleapis.com",
      },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap",
      },
      // Branded favicon: a violet shield on black.
      {
        rel: "icon",
        type: "image/svg+xml",
        href: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23000'/%3E%3Cpath d='M16 5l9 3.5v7c0 5.5-3.8 9.4-9 11.5-5.2-2.1-9-6-9-11.5v-7L16 5z' fill='none' stroke='%237C5CFC' stroke-width='2'/%3E%3Cpath d='M11.5 16l3 3 6-6' fill='none' stroke='%237C5CFC' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E",
      },
    ],
  }),
  // Root-level handlers: every child route inherits the styled 404 (unknown
  // paths + notFound()) and the styled 500 (any load/render/server-fn error).
  notFoundComponent: NotFoundPage,
  errorComponent: ({ error, reset }) => <ErrorPage error={error} onReset={reset} />,
  shellComponent: RootDocument,
  component: RootComponent,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        {/* Telegram Mini App SDK: present only when opened inside Telegram; a normal
            browser loads it too but window.Telegram.WebApp has no initData there. */}
        <script src="https://telegram.org/js/telegram-web-app.js" />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
    </QueryClientProvider>
  );
}
