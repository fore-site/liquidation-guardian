import { Button } from "./ui/button.js";

/** Minimal legal page — centered prose, consistent with the dark theme. */
export function LegalPage({ title, body }: { title: string; body: string }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <nav className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <a href="/" className="text-sm font-semibold tracking-tight">
            Liquidation<span className="text-accent">Guardian</span>
          </a>
          <Button asChild variant="ghost" size="sm">
            <a href="/">← Back to home</a>
          </Button>
        </div>
      </nav>
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <div className="mt-8 space-y-6 text-sm leading-relaxed text-muted-foreground">
          {body
            .trim()
            .split("\n\n")
            .map((block, i) => {
              const isHeading = block.startsWith("## ");
              return isHeading ? (
                <h2 key={i} className="pt-2 text-lg font-semibold text-foreground">
                  {block.replace(/^## /, "")}
                </h2>
              ) : (
                <p key={i}>{block}</p>
              );
            })}
        </div>
      </main>
    </div>
  );
}
