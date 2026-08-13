/// <reference types="vite/client" />
import { QueryClientProvider } from "@tanstack/react-query";
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import * as React from "react";
import "../styles.css";
import { ErrorPage, NotFoundPage } from "../components/ErrorPages.js";

export interface RouterContext { queryClient: QueryClient; }
export const Route = createRootRouteWithContext<RouterContext>()({
  // Note: og:image/twitter:image use relative paths — fine in the browser and
  // Telegram Mini App. Once deployed to a public domain (e.g. Vercel), swap to
  // absolute URLs (https://…/og-image.png) for social-link preview scrapers.
  head: () => ({ meta: [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }, { title: "Liquidation Guardian | Position protection before the line" }, { name: "description", content: "An event driven Guardian watches your Aave health factor, sizes a valid rescue, and executes through KeeperHub before liquidation." }, { name: "theme-color", content: "#0d0d0d" }, { property: "og:title", content: "Liquidation Guardian | Position protection before the line" }, { property: "og:description", content: "Watch your Aave position, choose the smallest valid rescue, and keep the execution boundary clear." }, { property: "og:type", content: "website" }, { property: "og:image", content: "/og-image.png" }, { property: "og:image:width", content: "1200" }, { property: "og:image:height", content: "630" }, { property: "og:image:alt", content: "Liquidation Guardian — stay above the line while you sleep" }, { name: "twitter:card", content: "summary_large_image" }, { name: "twitter:image", content: "/og-image.png" }], links: [{ rel: "preconnect", href: "https://fonts.googleapis.com" }, { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" }, { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600&family=Geist+Mono:wght@400;500;600&display=swap" }, { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }, { rel: "icon", type: "image/png", sizes: "32x32", href: "/favicon-32.png" }, { rel: "icon", type: "image/png", sizes: "16x16", href: "/favicon-16.png" }, { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" }, { rel: "manifest", href: "/site.webmanifest" } ] }),
  notFoundComponent: NotFoundPage,
  errorComponent: ({ error, reset }) => <ErrorPage error={error} onReset={reset} />,
  shellComponent: RootDocument,
  component: RootComponent,
});
function RootDocument({ children }: { children: React.ReactNode }) { return <html lang="en"><head><HeadContent /><script src="https://telegram.org/js/telegram-web-app.js" /></head><body>{children}<Scripts /></body></html>; }
function RootComponent() { const { queryClient } = Route.useRouteContext(); return <QueryClientProvider client={queryClient}><Outlet /></QueryClientProvider>; }
