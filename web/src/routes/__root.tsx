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
