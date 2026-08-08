import { Button } from "./ui/button.js";

/** Styled 404 — rendered by the root route's `notFoundComponent`. */
export function NotFoundPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-4 text-center text-foreground">
      <span className="font-mono text-7xl font-semibold tracking-tight text-accent">404</span>
      <h1 className="mt-4 text-2xl font-semibold">Page not found</h1>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
        The page you're looking for doesn't exist or was moved.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Button variant="outline" asChild>
          <a href="/">← Back to home</a>
        </Button>
        <Button asChild>
          <a href="/dashboard">Go to dashboard</a>
        </Button>
      </div>
    </div>
  );
}

/** Styled 500 — rendered by the root route's `errorComponent`. */
export function ErrorPage({
  error,
  onReset,
}: {
  error?: unknown;
  onReset?: () => void;
}) {
  const message = error instanceof Error && error.message ? error.message : undefined;
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-4 text-center text-foreground">
      <span className="font-mono text-7xl font-semibold tracking-tight text-destructive">500</span>
      <h1 className="mt-4 text-2xl font-semibold">Something went wrong</h1>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
        An unexpected error occurred. Your position is still being watched — try again.
      </p>
      {message && (
        <p className="mt-2 max-w-full truncate font-mono text-xs text-muted-foreground/70" title={message}>
          {message}
        </p>
      )}
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Button variant="outline" asChild>
          <a href="/">← Back to home</a>
        </Button>
        <Button onClick={onReset ?? (() => window.location.reload())}>Try again</Button>
      </div>
    </div>
  );
}
