/**
 * Minimal Telegram Bot API client — raw `fetch`, no dependency.
 *
 * Only the handful of methods the Guardian bot needs: long-poll for updates, send
 * and edit messages (with inline keyboards), answer callback queries, and set the
 * chat menu button that launches the Mini App. All hit
 * `https://api.telegram.org/bot<token>/<method>`.
 *
 * IMPORTANT: a KeeperHub key must NEVER be passed to any method here — Telegram
 * messages are an untrusted surface. This client only ever carries health factors,
 * amounts, and tx links.
 */
const API_BASE = "https://api.telegram.org";

/** A Telegram inline keyboard button. Either `callback_data` or `web_app` is set. */
export interface InlineButton {
  text: string;
  callback_data?: string;
  web_app?: { url: string };
  url?: string;
}

export type InlineKeyboard = InlineButton[][];

/** The slice of a Telegram update we act on. */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string; first_name?: string };
    chat: { id: number; type: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string };
    message?: { message_id: number; chat: { id: number } };
    data?: string;
  };
}

export class TelegramClient {
  constructor(private readonly token: string) {
    if (!token) throw new Error("TelegramClient needs a bot token.");
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const lastErr: unknown[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok: boolean;
          result?: T;
          description?: string;
        };
        if (!data.ok) {
          // 409/429 are transient-ish; everything else is definitive.
          if (res.status === 429 || res.status >= 500) {
            lastErr.push(new Error(`Telegram ${method} failed: ${data.description ?? res.status}`));
            await sleep(500 * attempt);
            continue;
          }
          throw new Error(`Telegram ${method} failed: ${data.description ?? res.status}`);
        }
        return data.result as T;
      } catch (err) {
        const aborted = err instanceof Error && err.name === "AbortError";
        lastErr.push(aborted ? new Error(`Telegram ${method} timed out`) : err);
        if (attempt === 3) break;
        await sleep(500 * attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr[lastErr.length - 1];
  }

  /**
   * Long-poll for updates. `offset` = last handled update_id + 1 (marks prior updates
   * confirmed so they aren't redelivered). `timeout` is the server-side hold in
   * seconds. The fetch timeout is set a bit beyond it so the hold isn't cut short.
   */
  async getUpdates(offset: number, timeoutSec = 25): Promise<TelegramUpdate[]> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), (timeoutSec + 5) * 1000);
    try {
      const res = await fetch(`${API_BASE}/bot${this.token}/getUpdates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offset, timeout: timeoutSec }),
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok: boolean;
        result?: TelegramUpdate[];
        description?: string;
      };
      if (!data.ok) throw new Error(`getUpdates failed: ${data.description ?? res.status}`);
      return data.result ?? [];
    } finally {
      clearTimeout(t);
    }
  }

  sendMessage(
    chatId: number,
    text: string,
    opts: { inlineKeyboard?: InlineKeyboard; parseMode?: "Markdown" | "HTML"; disablePreview?: boolean } = {},
  ): Promise<{ message_id: number }> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: opts.parseMode,
      disable_web_page_preview: opts.disablePreview ?? true,
      reply_markup: opts.inlineKeyboard ? { inline_keyboard: opts.inlineKeyboard } : undefined,
    });
  }

  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts: { inlineKeyboard?: InlineKeyboard; parseMode?: "Markdown" | "HTML" } = {},
  ): Promise<unknown> {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: opts.parseMode,
      disable_web_page_preview: true,
      reply_markup: opts.inlineKeyboard ? { inline_keyboard: opts.inlineKeyboard } : undefined,
    });
  }

  answerCallbackQuery(id: string, text?: string): Promise<unknown> {
    return this.call("answerCallbackQuery", { callback_query_id: id, text });
  }

  /**
   * Set the chat menu button (the "☰" next to the input) to launch the Mini App.
   * Only meaningful over HTTPS — `webAppUrl` must be a public HTTPS URL Telegram can
   * load. Called once at boot if WEBAPP_URL is configured.
   */
  setChatMenuButton(webAppUrl: string, text = "🛡 Open Guardian"): Promise<unknown> {
    return this.call("setChatMenuButton", {
      menu_button: { type: "web_app", text, web_app: { url: webAppUrl } },
    });
  }

  getMe(): Promise<{ id: number; username?: string }> {
    return this.call("getMe", {});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
