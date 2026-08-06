/**
 * The Liquidation Guardian Telegram bot: the phone-native "watch + approve" face.
 *
 * Runs in the same process as the HTTP API (see server/serve.ts), sharing the
 * encrypted {@link GuardianStore}. Two concurrent loops:
 *   - **long-poll loop** — pulls updates (commands, button taps) and handles them.
 *   - **watch loop** — every `watchIntervalMs`, re-reads every stored position; when
 *     one drops below its threshold it either alerts with one-tap rescue buttons or,
 *     if the user enabled `/auto`, executes the fix and just notifies.
 *
 * Reuses the existing engine unchanged: `runGuardianOnce` (auto path), `buildSnapshot`
 * + `computeCandidates` (sizing the buttons), and `executeRescue(candidateToDecision(…))`
 * on an approval — no re-implementation of the rescue logic.
 *
 * Security: onboarding (which carries the KeeperHub key) happens ONLY through the
 * Mini App → HTTPS POST, never here. This bot only ever sends health factors,
 * amounts, and tx links, and only acts on the record bound to a *verified* Telegram
 * user id.
 */
import type { LlmConfig } from "../src/agent/guardian.js";
import {
  buildSnapshot,
  executeRescue,
} from "../src/agent/guardian.js";
import { runAgenticRescue } from "../src/agent/agent.js";
import {
  candidateToDecision,
  computeCandidates,
  decideRescueWithLlm,
  decideRescueDeterministic,
  type RescueCandidate,
} from "../src/agent/decide.js";
import type { GuardianRecord, GuardianStore } from "./store.js";
import { TelegramClient, type InlineKeyboard, type TelegramUpdate } from "./telegram.js";

/** Don't re-alert the same at-risk position more often than this. */
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

export interface GuardianBotOptions {
  store: GuardianStore;
  botToken: string;
  /** Operator-owned LLM stack for the decision layer; null ⇒ deterministic fallback. */
  llm: LlmConfig | null;
  webAppUrl: string;
  watchIntervalMs: number;
}

export class GuardianBot {
  private readonly tg: TelegramClient;
  private readonly store: GuardianStore;
  private readonly llm: LlmConfig | null;
  private readonly webAppUrl: string;
  private readonly watchIntervalMs: number;
  private running = false;
  private offset = 0;

  constructor(opts: GuardianBotOptions) {
    this.tg = new TelegramClient(opts.botToken);
    this.store = opts.store;
    this.llm = opts.llm;
    this.webAppUrl = opts.webAppUrl;
    this.watchIntervalMs = opts.watchIntervalMs;
  }

  /** Start both loops. Resolves immediately; loops run until {@link stop}. */
  async start(): Promise<void> {
    this.running = true;
    const me = await this.tg.getMe().catch(() => null);
    console.log(`Telegram bot online${me?.username ? ` as @${me.username}` : ""}.`);
    if (this.webAppUrl) {
      await this.tg
        .setChatMenuButton(this.webAppUrl)
        .catch((e) => console.error("[bot] setChatMenuButton:", e instanceof Error ? e.message : e));
    }
    void this.pollLoop();
    void this.watchLoop();
  }

  stop(): void {
    this.running = false;
  }

  /**
   * Called by the HTTP onboarding right after a key is encrypted + stored with a
   * verified Telegram binding — pushes the in-chat confirmation.
   */
  async notifyOnboarded(record: GuardianRecord): Promise<void> {
    if (record.telegramChatId == null) return;
    await this.tg
      .sendMessage(
        record.telegramChatId,
        `✅ Connected. I'm now watching ${short(record.wallet)} on Aave (Sepolia).\n` +
          `I'll alert you if your health factor drops below ${record.hfThreshold} and can ` +
          `rescue it back to ${record.hfTarget}.\n\n` +
          `/status — check now · /auto — autonomous rescues · /help`,
      )
      .catch((e) => console.error("[bot] notifyOnboarded:", e instanceof Error ? e.message : e));
  }

  // ── long-poll loop ────────────────────────────────────────────────────────
  private async pollLoop(): Promise<void> {
    let backoffMs = 1_000;
    while (this.running) {
      try {
        const updates = await this.tg.getUpdates(this.offset, 25);
        backoffMs = 1_000; // success resets the backoff
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          await this.handleUpdate(u).catch((e) =>
            console.error("[bot] handleUpdate:", e instanceof Error ? e.message : e),
          );
        }
      } catch (e) {
        // Network blip / abort — back off exponentially (bounded) before retrying so
        // we don't hammer Telegram while it's unreachable.
        console.error("[bot] getUpdates:", e instanceof Error ? e.message : e);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  }

  private async handleUpdate(u: TelegramUpdate): Promise<void> {
    if (u.callback_query) return this.handleCallback(u.callback_query);
    const msg = u.message;
    if (!msg?.text || !msg.from) return;
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const cmd = msg.text.trim().split(/\s+/)[0].toLowerCase().replace(/@.*$/, "");

    switch (cmd) {
      case "/start":
        return this.cmdStart(chatId);
      case "/status":
        return this.cmdStatus(chatId, userId);
      case "/auto":
        return this.cmdAuto(chatId, userId);
      case "/stop":
        return this.cmdStop(chatId, userId);
      case "/help":
        return this.cmdHelp(chatId);
      default:
        await this.tg.sendMessage(chatId, "Unknown command. Try /help.");
    }
  }

  private async cmdStart(chatId: number): Promise<void> {
    const keyboard: InlineKeyboard | undefined = this.webAppUrl
      ? [[{ text: "🛡 Connect your position", web_app: { url: this.webAppUrl } }]]
      : undefined;
    await this.tg.sendMessage(
      chatId,
      "👋 I'm the Liquidation Guardian.\n\n" +
        "I watch your Aave borrow position and step in before it gets liquidated — " +
        "repaying debt or adding collateral, executed onchain through KeeperHub.\n\n" +
        (this.webAppUrl
          ? "Tap below to connect your position. Your KeeperHub key goes straight to the " +
            "server over HTTPS — never through this chat."
          : "Onboarding runs through the web app (Mini App URL not configured on this server)."),
      { inlineKeyboard: keyboard },
    );
  }

  private async cmdHelp(chatId: number): Promise<void> {
    await this.tg.sendMessage(
      chatId,
      "Commands:\n" +
        "/status — current health factor + position\n" +
        "/auto — toggle autonomous rescues (execute + notify, no tap needed)\n" +
        "/stop — stop watching + unbind this chat\n" +
        "/start — connect a position\n\n" +
        "By default I ask before acting: when you're at risk I send the sized fix with " +
        "one-tap buttons. Nothing broadcasts until you approve.",
    );
  }

  private async cmdStatus(chatId: number, userId: number): Promise<void> {
    const record = await this.store.getByTelegramUser(userId);
    if (!record) return this.replyOnboardFirst(chatId);
    try {
      const kh = this.store.keeperHubFor(record);
      const pos = await kh.readAavePosition(record.chainId, record.wallet);
      const hf = Number.isFinite(pos.healthFactor) ? pos.healthFactor.toFixed(4) : "∞ (no debt)";
      const risk =
        Number.isFinite(pos.healthFactor) && pos.healthFactor < record.hfThreshold
          ? "⚠️ below threshold"
          : "✅ healthy";
      await this.tg.sendMessage(
        chatId,
        `${risk}\n` +
          `Wallet: ${short(record.wallet)}\n` +
          `Health factor: ${hf}  (act below ${record.hfThreshold})\n` +
          `Collateral: $${pos.totalCollateralUsd.toFixed(2)} · Debt: $${pos.totalDebtUsd.toFixed(2)}\n` +
          `Mode: ${record.autoMode ? "🤖 autonomous" : "✋ approval"}`,
      );
    } catch (e) {
      await this.tg.sendMessage(chatId, `Couldn't read your position: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async cmdAuto(chatId: number, userId: number): Promise<void> {
    const record = await this.store.getByTelegramUser(userId);
    if (!record) return this.replyOnboardFirst(chatId);
    const updated = await this.store.setAutoMode(record.id, !record.autoMode);
    if (!updated) return this.replyOnboardFirst(chatId);
    await this.tg.sendMessage(
      chatId,
      updated.autoMode
        ? "🤖 Autonomous mode ON. I'll execute the cheapest fix and notify you — no tap needed."
        : "✋ Autonomous mode OFF. I'll ask for a one-tap approval before any rescue.",
    );
  }

  private async cmdStop(chatId: number, userId: number): Promise<void> {
    const record = await this.store.getByTelegramUser(userId);
    if (!record) return this.replyOnboardFirst(chatId);
    await this.store.remove(record.id);
    await this.tg.sendMessage(
      chatId,
      "🛑 Stopped watching and removed your stored credential. Re-connect any time with /start.",
    );
  }

  private async replyOnboardFirst(chatId: number): Promise<void> {
    const keyboard: InlineKeyboard | undefined = this.webAppUrl
      ? [[{ text: "🛡 Connect your position", web_app: { url: this.webAppUrl } }]]
      : undefined;
    await this.tg.sendMessage(chatId, "You're not connected yet. Onboard first:", {
      inlineKeyboard: keyboard,
    });
  }

  // ── callback (button tap) handling ──────────────────────────────────────────
  private async handleCallback(cq: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
    const data = cq.data ?? "";
    const chatId = cq.message?.chat.id;
    const messageId = cq.message?.message_id;
    const userId = cq.from.id;
    if (chatId == null || messageId == null) {
      return void this.tg.answerCallbackQuery(cq.id);
    }

    const [tag, action, asset] = data.split("|");
    if (tag !== "rs") return void this.tg.answerCallbackQuery(cq.id);

    if (action === "ignore") {
      await this.tg.answerCallbackQuery(cq.id, "Dismissed");
      await this.tg.editMessageText(chatId, messageId, "✋ Ignored. I'll keep watching.");
      return;
    }

    const record = await this.store.getByTelegramUser(userId);
    if (!record) {
      await this.tg.answerCallbackQuery(cq.id, "Not connected");
      return;
    }

    await this.tg.answerCallbackQuery(cq.id, "Executing…").catch(() => undefined);
    // Editing is cosmetic — a "message not modified" (double-tap) failure must not
    // be mistaken for a rescue failure, so isolate it from the real work.
    await this.tg.editMessageText(chatId, messageId, `⏳ Executing ${action} ${asset}…`).catch(() => undefined);

    try {
      // Re-read + re-size at approval time so we never act on a stale amount.
      const kh = this.store.keeperHubFor(record);
      const pos = await kh.readAavePosition(record.chainId, record.wallet);
      if (Number.isFinite(pos.healthFactor) && pos.healthFactor >= record.hfTarget) {
        await this.tg.editMessageText(
          chatId,
          messageId,
          `✅ Already healthy (HF ${pos.healthFactor.toFixed(4)}). No action needed.`,
        );
        return;
      }
      const snapshot = await buildSnapshot(kh, record.chainId, record.wallet, pos);
      const candidates = computeCandidates(snapshot, record.hfTarget);
      const chosen = candidates.find(
        (c) => c.available && c.action === action && c.asset.symbol.toUpperCase() === asset.toUpperCase(),
      );
      if (!chosen) {
        await this.tg.editMessageText(chatId, messageId, `That lever is no longer available. Try /status.`);
        return;
      }
      const decision = candidateToDecision(
        chosen,
        `User-approved ${chosen.action} of ${fmt(chosen.amountHuman)} ${chosen.asset.symbol} via Telegram.`,
      );
      const result = await executeRescue({
        keeperHub: kh,
        chainId: record.chainId,
        user: record.wallet,
        decision,
        position: pos,
      });
      await this.store.markAlerted(record.id);
      await this.tg.editMessageText(chatId, messageId, this.renderResult(result, chosen)).catch(() => undefined);
    } catch (e) {
      await this.tg.editMessageText(
        chatId,
        messageId,
        `❌ Rescue failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // ── watch loop ──────────────────────────────────────────────────────────────
  private async watchLoop(): Promise<void> {
    // Small initial delay so the store/connection settle before the first sweep.
    await sleep(3000);
    let backoffMs = this.watchIntervalMs;
    while (this.running) {
      try {
        await this.watchTick();
        backoffMs = this.watchIntervalMs;
      } catch (e) {
        // A tick failed wholesale (e.g. Redis down) — back off exponentially so we
        // don't spin, but keep trying.
        console.error("[bot] watchTick:", e instanceof Error ? e.message : e);
        backoffMs = Math.min(backoffMs * 2, 10 * 60 * 1000);
      }
      await sleep(backoffMs);
    }
  }

  private async watchTick(): Promise<void> {
    const records = await this.store.all();
    for (const record of records) {
      // Only watch records with a chat to notify.
      if (record.telegramChatId == null) continue;
      try {
        await this.runCheck(record);
      } catch (e) {
        console.error(`[bot] check ${short(record.wallet)}:`, e instanceof Error ? e.message : e);
      }
    }
  }

  /**
   * Run the full per-record check: read HF → below threshold? → de-dupe →
   * auto-rescue (agentic loop) or approval buttons. Shared by the watch loop and
   * the event-driven watcher — the only difference is *when* it's called.
   */
  async runCheck(record: GuardianRecord): Promise<void> {
    const chatId = record.telegramChatId!;
    const kh = this.store.keeperHubFor(record);
    const pos = await kh.readAavePosition(record.chainId, record.wallet);
    if (!Number.isFinite(pos.healthFactor) || pos.healthFactor >= record.hfThreshold) return; // healthy
    if (pos.totalDebtUsd <= 0) return;

    // De-dupe: don't re-alert/re-act within the cooldown window.
    if (record.lastAlertAt && Date.now() - record.lastAlertAt < ALERT_COOLDOWN_MS) return;

    if (record.autoMode) {
      let result;
      try {
        result = await runAgenticRescue({
          keeperHub: kh,
          llm: this.llm,
          chainId: record.chainId,
          user: record.wallet,
          hfThreshold: record.hfThreshold,
          hfTarget: record.hfTarget,
          maxSteps: 3, // the agent loops until safe or 3 steps spent
        });
      } catch (err) {
        // Rescue failed — do NOT mark alerted, so the next tick retries; and tell
        // the user instead of silently dropping it.
        console.error(`[bot] auto-rescue for ${short(record.wallet)} failed:`, err instanceof Error ? err.message : err);
        await this.tg
          .sendMessage(
            chatId,
            `❌ Auto-rescue failed for ${short(record.wallet)}: ${err instanceof Error ? err.message : err}. I'll keep watching.`,
          )
          .catch(() => undefined);
        return;
      }
      // Only after a completed pass (any outcome) do we de-dupe the next tick.
      await this.store.markAlerted(record.id);
      await this.tg.sendMessage(chatId, `🤖 Auto-rescue triggered.\n${this.renderAgentRun(result)}`);
      return;
    }

    // Approval mode: size the levers, recommend one, send buttons.
    const snapshot = await buildSnapshot(kh, record.chainId, record.wallet, pos);
    const candidates = computeCandidates(snapshot, record.hfTarget);
    const available = candidates.filter((c) => c.available && c.amountUnits > 0n);
    if (available.length === 0) return; // nothing sizeable to offer

    let recommendation = "";
    try {
      let decision;
      if (this.llm) {
        const r = await decideRescueWithLlm({
          client: this.llm.client,
          model: this.llm.model,
          timeoutMs: this.llm.timeoutMs,
          input: { snapshot, hfThreshold: record.hfThreshold, hfTarget: record.hfTarget },
        });
        decision = r.decision;
      } else {
        decision = decideRescueDeterministic(snapshot, record.hfTarget);
      }
      recommendation = `\n🤖 Recommends: ${decision.action} ${fmt(decision.amountHuman)} ${decision.asset} — ${decision.reasoning}`;
    } catch {
      /* recommendation is best-effort; buttons still work without it */
    }

    const buttons: InlineKeyboard = available.map((c) => [
      {
        text: `${c.action === "repay" ? "✅ Repay" : "🛡 Supply"} ${fmt(c.amountHuman)} ${c.asset.symbol}` +
          (c.reachesTarget ? "" : " (partial)"),
        callback_data: `rs|${c.action}|${c.asset.symbol}`,
      },
    ]);
    buttons.push([{ text: "✋ Ignore", callback_data: "rs|ignore" }]);

    await this.tg.sendMessage(
      chatId,
      `⚠️ Liquidation risk on ${short(record.wallet)}\n` +
        `Health factor ${pos.healthFactor.toFixed(4)} < ${record.hfThreshold} ` +
        `(liquidation at 1.0)\n` +
        `Debt $${pos.totalDebtUsd.toFixed(2)} · Collateral $${pos.totalCollateralUsd.toFixed(2)}` +
        recommendation +
        `\n\nPick a fix — nothing broadcasts until you tap:`,
      { inlineKeyboard: buttons },
    );
    await this.store.markAlerted(record.id);
  }

  /** Human-readable outcome for an agentic rescue run (multi-step history). */
  private renderAgentRun(result: Awaited<ReturnType<typeof runAgenticRescue>>): string {
    const hf = Number.isFinite(result.position.healthFactor)
      ? result.position.healthFactor.toFixed(4)
      : "∞";
    const lines = result.steps.map((s) => {
      const what = `${s.decision.action} ${fmt(s.decision.amountHuman)} ${s.decision.asset} (${s.provider})`;
      const hfBit = `HF ${s.hfBefore.toFixed(4)} → ${s.hfAfter.toFixed(4)}`;
      const link = s.transactionLink ? `\n${s.transactionLink}` : "";
      return `  step ${s.index}: ${what} — ${hfBit}${link}`;
    });
    const head =
      result.status === "goal_met"
        ? `✅ Rescue complete.`
        : result.status === "healthy"
          ? `✅ Position healthy (HF ${hf}).`
          : result.status === "no_action"
            ? `ℹ️ No action: ${result.summary}.`
            : `⏸️ Budget hit — HF ${hf}. ${result.summary}`;
    return [head, ...lines].join("\n");
  }

  /** Human-readable outcome for a GuardianResult, with the tx link when present. */
  private renderResult(
    result: Awaited<ReturnType<typeof executeRescue>>,
    chosen?: RescueCandidate,
  ): string {
    const hf = Number.isFinite(result.position.healthFactor)
      ? result.position.healthFactor.toFixed(4)
      : "∞";
    switch (result.status) {
      case "rescued": {
        const what = result.decision
          ? `${result.decision.action} ${fmt(result.decision.amountHuman)} ${result.decision.asset}`
          : chosen
            ? `${chosen.action} ${fmt(chosen.amountHuman)} ${chosen.asset.symbol}`
            : "rescue";
        const link = result.transactionLink ?? result.transactionHash;
        return `✅ ${cap(what)} done. Health factor now ${hf}.${link ? `\n${link}` : ""}`;
      }
      case "healthy":
        return `✅ Position healthy (HF ${hf}). No action needed.`;
      case "simulation_failed":
        return `❌ Simulation/execution failed: ${result.detail ?? "unknown error"}`;
      case "no_action":
        return `ℹ️ No action: ${result.detail ?? "nothing to do"}.`;
      default:
        return `Result: ${result.status}`;
    }
  }
}

// ── small helpers ───────────────────────────────────────────────────────────
function short(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
function fmt(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "∞";
}
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
