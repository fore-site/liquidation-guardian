import OpenAI from "openai";
import "dotenv/config";
import { decideRescue } from "../src/agent/decide.js";

// Realistic single-asset LINK/LINK position: collateral ~$8k, debt ~$6k, HF ~1.13
// (price-free — single asset per side, no oracle needed).
const client = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
});

const LINK = 10n ** 18n;
const snapshot = {
  healthFactor: 1.08,
  totalDebtUsd: 6000,
  totalCollateralUsd: 8000,
  aggregateLiqThreshold: 0.85,
  debts: [{ symbol: "LINK", address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: 18, tokens: 100n * LINK }],
  collaterals: [{ symbol: "LINK", address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: 18, tokens: 200n * LINK, liqThresholdBps: 8500 }],
};

try {
  const d = await decideRescue(client, {
    snapshot: snapshot as never,
    hfThreshold: 1.15,
    hfTarget: 1.5,
    model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
    timeoutMs: 30000,
    strictSchema: true,
  });
  console.log(
    "GEMINI DECISION OK:",
    JSON.stringify(d, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2),
  );
} catch (e) {
  console.log("GEMINI DECISION FAILED:", e instanceof Error ? e.message : String(e));
}
