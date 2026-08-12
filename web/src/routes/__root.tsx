/// <reference types="vite/client" />
import { QueryClientProvider } from "@tanstack/react-query";
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import * as React from "react";
import "../styles.css";
import { ErrorPage, NotFoundPage } from "../components/ErrorPages.js";

export interface RouterContext { queryClient: QueryClient; }
export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({ meta: [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }, { title: "Liquidation Guardian | Position protection before the line" }, { name: "description", content: "An event driven Guardian watches your Aave health factor, sizes a valid rescue, and executes through KeeperHub before liquidation." }, { name: "theme-color", content: "#0D0D0D" }, { property: "og:title", content: "Liquidation Guardian | Position protection before the line" }, { property: "og:description", content: "Watch your Aave position, choose the smallest valid rescue, and keep the execution boundary clear." }, { property: "og:type", content: "website" }], links: [{ rel: "preconnect", href: "https://fonts.googleapis.com" }, { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" }, { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600&family=Geist+Mono:wght@400;500;600&display=swap" }, { rel: "icon", type: "image/svg+xml", href: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%230D0D0D'/%3E%3Cpath d='M8 16h16M16 8v16' stroke='%23FF3B0E' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E" }] }),
  notFoundComponent: NotFoundPage,
  errorComponent: ({ error, reset }) => <ErrorPage error={error} onReset={reset} />,
  shellComponent: RootDocument,
  component: RootComponent,
});
function RootDocument({ children }: { children: React.ReactNode }) { return <html lang="en"><head><HeadContent /><script src="https://telegram.org/js/telegram-web-app.js" /></head><body>{children}<Scripts /></body></html>; }
function RootComponent() { const { queryClient } = Route.useRouteContext(); return <QueryClientProvider client={queryClient}><Outlet /></QueryClientProvider>; }
