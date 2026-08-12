import type { ReactNode } from "react";
import { BrandMark } from "./BrandMark.js";

export function PageShell({ children, className = "", main = true }: { children: ReactNode; className?: string; main?: boolean }) {
  const content = <div className={`container-frame ${className}`}>{children}</div>;
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="container-frame flex h-16 items-center justify-between">
          <a href="/" aria-label="Liquidation Guardian home"><BrandMark /></a>
          <a href="/" className="text-sm text-muted-foreground transition-colors duration-300 hover:text-foreground">Back to home</a>
        </div>
      </header>
      {main ? <main>{content}</main> : content}
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="container-frame flex flex-col gap-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <BrandMark />
        <nav className="flex gap-5" aria-label="Footer">
          <a href="/privacy" className="transition-colors duration-300 hover:text-foreground">Privacy</a>
          <a href="/terms" className="transition-colors duration-300 hover:text-foreground">Terms</a>
          <a href="https://keeperhub.com" target="_blank" rel="noreferrer" className="transition-colors duration-300 hover:text-foreground">KeeperHub</a>
        </nav>
      </div>
    </footer>
  );
}
