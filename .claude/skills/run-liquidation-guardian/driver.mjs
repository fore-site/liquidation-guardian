#!/usr/bin/env node
/**
 * driver.mjs — zero-dependency browser driver for the Guardian web app.
 *
 * The app (TanStack Start + nitro) has no headless-drivable API of its own, so we
 * drive real Chrome over the Chrome DevTools Protocol (CDP). No npm deps: we use
 * Node 22's built-in global `WebSocket` as the CDP transport and system
 * `google-chrome --headless`. Nothing to `npm install`.
 *
 * What it does:
 *   1. launches google-chrome headless with --remote-debugging-port
 *   2. connects to the page target over CDP
 *   3. screenshots the landing (/) and onboarding (/onboard)
 *   4. if KEEPERHUB_API_KEY + WALLET_ADDRESS are in the env, drives the
 *      onboarding form → dashboard and screenshots the live dashboard
 *
 * Prereqs: the web app already running on http://localhost:3000 (serve.sh).
 *
 * Usage (creds come from the env, never hardcoded):
 *   set -a; . ./.env; set +a
 *   node .claude/skills/run-liquidation-guardian/driver.mjs
 *
 * Screenshots land in .claude/skills/run-liquidation-guardian/shots/.
 * Flags: --base=<url> (default http://localhost:3000), --no-dashboard.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "shots");
mkdirSync(SHOTS, { recursive: true });

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const BASE = arg("base", "http://localhost:3000").replace(/\/$/, "");
const WANT_DASHBOARD = !process.argv.includes("--no-dashboard");
const CHROME =
  process.env.CHROME_BIN ||
  "/usr/bin/google-chrome";
const DEBUG_PORT = 9333;

const KH_KEY = process.env.KEEPERHUB_API_KEY || "";
const WALLET = process.env.WALLET_ADDRESS || "";

// ── tiny CDP client over the built-in WebSocket ───────────────────────────────
class CDP {
  #ws;
  #id = 0;
  #pending = new Map();
  #listeners = new Map();
  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.#pending.has(msg.id)) {
        const { resolve, reject } = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        (this.#listeners.get(msg.method) || []).forEach((fn) => fn(msg.params));
      }
    });
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("CDP ws error")), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    const msg = sessionId ? { id, method, params, sessionId } : { id, method, params };
    this.#ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }
  on(method, fn) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, []);
    this.#listeners.get(method).push(fn);
  }
}

async function getJSON(path) {
  const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}${path}`);
  return r.json();
}

async function main() {
  // 1. Launch Chrome headless with a FRESH profile (wipe any prior session
  //    cookie so each run starts unauthenticated and deterministic).
  const profile = `/tmp/guardian-chrome-${DEBUG_PORT}`;
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--no-sandbox",
      "--window-size=1280,1600",
      "about:blank",
    ],
    { stdio: "ignore", detached: false },
  );
  const cleanup = () => { try { chrome.kill("SIGKILL"); } catch {} };
  process.on("exit", cleanup);

  // 2. Wait for the CDP endpoint, then open a page target.
  let wsUrl = "";
  for (let i = 0; i < 50; i++) {
    try {
      const v = await getJSON("/json/version");
      wsUrl = v.webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch {}
    await sleep(200);
  }
  if (!wsUrl) throw new Error("Chrome CDP endpoint never came up");

  const browser = await CDP.connect(wsUrl);
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  // Reuse the SAME connection (flatten mode routes by top-level sessionId).
  const page = browser;
  const S = (method, params = {}) => page.send(method, params, sessionId);

  await S("Page.enable");
  await S("Runtime.enable");
  await S("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 1600, deviceScaleFactor: 1, mobile: false,
  });

  async function goto(path) {
    await S("Page.navigate", { url: `${BASE}${path}` });
    await waitForLoad();
  }
  function waitForLoad() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      page.on("Page.loadEventFired", finish);
      setTimeout(finish, 8000); // hard cap
    });
  }
  async function evalJs(expression) {
    const r = await S("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const msg = d.exception?.description || d.exception?.value || d.text || "eval threw";
      throw new Error(String(msg).split("\n")[0]);
    }
    return r.result.value;
  }
  async function shot(name) {
    const { data } = await S("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    const { writeFileSync } = await import("node:fs");
    const p = join(SHOTS, `${name}.png`);
    writeFileSync(p, Buffer.from(data, "base64"));
    console.log(`  📸 ${p}`);
  }

  // 3. Landing + onboarding (no creds needed).
  console.log("→ landing /");
  await goto("/");
  await sleep(1200);
  const h1 = await evalJs(`document.querySelector('h1')?.innerText || document.title`);
  console.log(`  h1/title: ${JSON.stringify(h1)?.slice(0, 80)}`);
  await shot("01-landing");

  console.log("→ onboarding /onboard");
  await goto("/onboard");
  await sleep(1000);
  const hasKeyField = await evalJs(`!!document.querySelector('#kh')`);
  console.log(`  onboarding form present: ${hasKeyField}`);
  await shot("02-onboard");

  // 4. Full flow → dashboard (needs live KeeperHub creds from the env).
  if (WANT_DASHBOARD && KH_KEY && WALLET) {
    console.log("→ driving onboarding form → dashboard");
    // Fresh profile ⇒ /onboard shows the form. (If a session cookie already
    // existed it would have redirected to /dashboard; guard for that.)
    const onOnboard = await evalJs(`location.pathname === '/onboard' && !!document.querySelector('#kh')`);
    if (onOnboard) {
      // React-safe field set: use the native value setter, then fire `input`.
      await evalJs(`(() => {
        const set = (sel, val) => {
          const el = document.querySelector(sel);
          if (!el) throw new Error('missing ' + sel);
          const proto = Object.getPrototypeOf(el);
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('#kh', ${JSON.stringify(KH_KEY)});
        set('#wallet', ${JSON.stringify(WALLET)});
      })()`);
      await sleep(300);
      await shot("03-onboard-filled");
      // Submit the "Connect & watch" form (the last submit button; the first one
      // belongs to the resume form).
      const clicked = await evalJs(`(() => {
        const btns = Array.from(document.querySelectorAll('button[type="submit"]'));
        const connect = btns.filter(b => /connect/i.test(b.textContent || '')).pop() || btns.pop();
        if (!connect) return 'no-submit-button';
        connect.click();
        return connect.textContent.trim();
      })()`);
      console.log(`  clicked: ${JSON.stringify(clicked)}`);
    } else {
      console.log("  (already authenticated — going straight to /dashboard)");
      await goto("/dashboard");
    }
    // The server probes the live Aave position (KeeperHub round-trip) then routes
    // to /dashboard. Poll for the health-factor hero to appear.
    let onDash = false;
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      const url = await evalJs(`location.pathname`);
      const err = await evalJs(`document.querySelector('.text-risk')?.innerText || ''`);
      if (url === "/dashboard") {
        const ready = await evalJs(
          `!!document.body.innerText.match(/health factor/i) && !/Loading/.test(document.body.innerText.slice(0,400))`,
        );
        if (ready) { onDash = true; break; }
      }
      if (err && err.length > 4) { console.log(`  onboarding error: ${err}`); break; }
    }
    if (onDash) {
      await sleep(1500);
      console.log("  ✓ dashboard loaded");
      await shot("04-dashboard");
    } else {
      console.log("  ⚠ dashboard did not load (see 04-onboard-state)");
      await shot("04-onboard-state");
    }
  } else if (WANT_DASHBOARD) {
    console.log("→ skipping dashboard: set KEEPERHUB_API_KEY + WALLET_ADDRESS to drive it");
  }

  console.log("done.");
  cleanup();
  process.exit(0);
}

main().catch((e) => { console.error("driver failed:", e); process.exit(1); });
