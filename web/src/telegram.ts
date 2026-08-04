/**
 * Telegram Mini App glue for the web front-end.
 *
 * When the dashboard is opened *inside* Telegram (via the bot's Mini App button),
 * `window.Telegram.WebApp` is populated and `initData` is a signed string the server
 * verifies to authenticate the Telegram user. In a normal browser the global is
 * absent (or `initData` is empty), so everything here degrades to plain web behavior.
 */

interface TelegramWebApp {
  initData: string;
  ready: () => void;
  expand: () => void;
  colorScheme?: "light" | "dark";
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function telegramWebApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null;
}

/** True when running inside Telegram with a signed session to send. */
export function isInTelegram(): boolean {
  const wa = telegramWebApp();
  return !!wa && typeof wa.initData === "string" && wa.initData.length > 0;
}

/** Signed initData to include in onboarding, or "" outside Telegram. */
export function telegramInitData(): string {
  return telegramWebApp()?.initData ?? "";
}

/** Call once on mount so Telegram renders the webview at full height. */
export function initTelegram(): void {
  const wa = telegramWebApp();
  if (!wa) return;
  try {
    wa.ready();
    wa.expand();
  } catch {
    /* non-fatal: older clients may not implement every method */
  }
}
