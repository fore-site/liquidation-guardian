import { Button } from "./ui/button.js";
import { Card, CardContent } from "./ui/card.js";

/**
 * Styled 404 page — rendered by the root route's `notFoundComponent` for any
 * unknown path (or `notFound()` thrown from a loader). Matches the dark/purple
 * theme; reuses the Card + Button UI kit.
 */
export function NotFoundPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <Card className="w-full max-w-md bg-card">
        <CardContent className="flex flex-col items-center gap-4 pt-8 text-center">
          <span className="text-6xl font-black tracking-tight text-primary">404</span>
          <h1 className="text-2xl font-bold">Page not found</h1>
          <p className="text-sm text-muted-foreground">
            The page you're looking for doesn't exist or was moved.
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            <Button variant="outline" asChild>
              <a href="/">← Back to home</a>
            </Button>
            <Button asChild>
              <a href="/dashboard">Go to dashboard</a>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Styled 500 page — rendered by the root route's `errorComponent` for any
 * error thrown during a route load, render, or server-fn call. Shows a
 * best-effort message (never a stack trace); "Try again" resets the route via
 * TanStack's error boundary reset.
 */
export function ErrorPage({
  error,
  onReset,
}: {
  error?: unknown;
  onReset?: () => void;
}) {
  const message =
    error instanceof Error && error.message ? error.message : undefined;
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <Card className="w-full max-w-md bg-card">
        <CardContent className="flex flex-col items-center gap-4 pt-8 text-center">
          <span className="text-6xl font-black tracking-tight text-destructive">500</span>
          <h1 className="text-2xl font-bold">Something went wrong</h1>
          <p className="text-sm text-muted-foreground">
            An unexpected error occurred. Your position is still being watched — try again.
          </p>
          {message && (
            <p className="max-w-full truncate text-xs text-muted-foreground/70" title={message}>
              {message}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            <Button variant="outline" asChild>
              <a href="/">← Back to home</a>
            </Button>
            <Button onClick={onReset ?? (() => window.location.reload())}>Try again</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
