/**
 * Deploy the Liquidation Guardian monitor workflow to KeeperHub.
 *
 * What this does, and why it's shaped this way:
 *   - The graph is defined in code (src/workflows/liquidation-monitor.ts) — the
 *     reproducible source of truth. This script pushes it to the account and
 *     writes src/workflows/liquidation-monitor.json as a reviewable artifact.
 *   - KeeperHub's hosted API does NOT expose REST create (POST /api/workflows
 *     returns 405 — creation is via the MCP `create_workflow` tool or the web UI).
 *     REST *does* expose GET / PATCH / DELETE. So this script deploys by
 *     reconciling an EXISTING workflow in place with PATCH: it finds the mainnet
 *     stub "Aave Health Factor Monitor" (the draft we're approved to replace) or a
 *     prior copy of ours, and overwrites it with our correct graph — reusing that
 *     object's id. If there's nothing to reconcile, it prints how to create the
 *     workflow once via MCP/UI, then re-run.
 *   - The HTTP-Request handoff node is a KeeperHub **Pro** feature. By default we
 *     deploy the free watcher (Schedule → read HF → Condition) and the Guardian is
 *     triggered out-of-band. Pass --with-http to attempt the in-workflow webhook
 *     handoff; if the plan rejects it (402 upgrade_required) we fall back to the
 *     free watcher and say so.
 *   - The monitor is deployed **disabled** (enabled:false) so no schedule fires
 *     until you turn it on in the UI or with --enable.
 *
 * Run:  npm run deploy-workflow                 (free watcher, disabled)
 *       npm run deploy-workflow -- --with-http   (attempt Pro webhook handoff)
 *       npm run deploy-workflow -- --enable      (…and enable the schedule now)
 *       npm run deploy-workflow -- --dry-run     (build + write JSON, no API writes)
 */
import "../src/net.js"; // patient IPv6→IPv4 failover; must run before any fetch
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { KeeperHub, KeeperHubError, type WorkflowSummary } from "../src/keeperhub.js";
import {
  buildMonitorWorkflow,
  WORKFLOW_NAME,
  type MonitorWorkflow,
} from "../src/workflows/liquidation-monitor.js";

/** The draft we're approved to replace (an empty mainnet placeholder). */
const STUB_NAME = "Aave Health Factor Monitor";

/** True when a write was rejected because it needs a paid plan (the HTTP node). */
function isUpgradeRequired(err: unknown): boolean {
  if (err instanceof KeeperHubError) {
    const body = err.body as { code?: string } | undefined;
    if (body?.code === "upgrade_required") return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /require[sd]? a paid plan|upgrade_required/i.test(msg);
}

/** Best-effort delete of an extra duplicate; never aborts the deploy. */
async function tryDelete(kh: KeeperHub, w: WorkflowSummary): Promise<void> {
  try {
    await kh.deleteWorkflow(w.id);
    console.log(`Deleted duplicate "${w.name}" (${w.id})`);
  } catch (err) {
    const why = err instanceof KeeperHubError ? err.message : String(err);
    console.log(`(Left duplicate "${w.name}" (${w.id}) in place — ${why})`);
  }
}

/** Overwrite an existing workflow object with our graph (reuse its id). */
function patchInPlace(
  kh: KeeperHub,
  id: string,
  wf: MonitorWorkflow,
  enable: boolean,
): Promise<WorkflowSummary> {
  return kh.updateWorkflow(id, {
    name: wf.name,
    description: wf.description,
    nodes: wf.nodes,
    edges: wf.edges,
    enabled: enable,
  });
}

async function main(): Promise<void> {
  const enable = process.argv.includes("--enable");
  const dryRun = process.argv.includes("--dry-run");
  const withHttp = process.argv.includes("--with-http");
  const cfg = loadConfig();

  const webhookUrl = cfg.guardianWebhookUrl || "https://webhook.site/REPLACE-ME";
  if (withHttp && !cfg.guardianWebhookUrl) {
    console.log(
      "⚠️  --with-http but GUARDIAN_WEBHOOK_URL not set — using a placeholder. Set\n" +
        "   GUARDIAN_WEBHOOK_URL (a tunnel to the Guardian, or a webhook.site URL to\n" +
        "   watch the payload) and re-run to point the handoff at a real endpoint.\n",
    );
  }

  // Build the graph. Default = free watcher (no HTTP node). --with-http adds the
  // Pro handoff; we fall back to the watcher below if the plan rejects it.
  const build = (includeHandoff: boolean): MonitorWorkflow =>
    buildMonitorWorkflow({
      chainId: cfg.chainId,
      user: cfg.walletAddress,
      hfThreshold: cfg.hfThreshold,
      scheduleCron: cfg.scheduleCron,
      includeHandoff,
      webhookUrl,
    });
  let wf = build(withHttp);

  // Always write the artifact — reproducible record of what we build.
  const here = dirname(fileURLToPath(import.meta.url));
  const artifact = resolve(here, "../src/workflows/liquidation-monitor.json");
  const writeArtifact = (w: MonitorWorkflow): void => {
    writeFileSync(artifact, JSON.stringify(w, null, 2) + "\n");
  };
  writeArtifact(wf);
  console.log(`Wrote workflow artifact → ${artifact}`);
  console.log(
    `  trigger: Schedule "${cfg.scheduleCron}" (UTC) · ` +
      `watch: ${cfg.walletAddress} on chain ${cfg.chainId} · ` +
      `act when HF < ${cfg.hfThreshold}`,
  );
  console.log(
    withHttp
      ? `  handoff: HTTP POST ${webhookUrl} (Pro node — falls back to watcher if gated)`
      : "  handoff: out-of-band (free plan; Guardian triggered separately)",
  );

  if (dryRun) {
    console.log("\n--dry-run: no API changes made.");
    return;
  }

  const kh = new KeeperHub({ apiKey: cfg.keeperHubApiKey });

  // Reconcile: find the stub / a prior copy of ours, and overwrite ONE of them in
  // place (KeeperHub has no REST create). Drop any extra duplicates.
  const existing = await kh.listWorkflows();
  const stale = existing.filter((w) => w.name === STUB_NAME || w.name === WORKFLOW_NAME);
  // Prefer overwriting a prior copy of ours; else the stub.
  stale.sort((a, b) => (a.name === WORKFLOW_NAME ? -1 : 0) - (b.name === WORKFLOW_NAME ? -1 : 0));

  const target = stale[0];
  if (!target) {
    console.log(
      "\nNo stub or prior monitor to reconcile, and KeeperHub's hosted API has no\n" +
        "REST create (POST /api/workflows → 405). Create the workflow once, then\n" +
        "re-run this script to keep it in sync:\n" +
        `  • Import ${artifact} in the web UI (app.keeperhub.com), or\n` +
        "  • create it via the MCP `create_workflow` tool using that JSON.\n",
    );
    return;
  }

  // Drop the extras we won't reuse (best-effort).
  for (const w of stale.slice(1)) await tryDelete(kh, w);

  let result: WorkflowSummary;
  try {
    result = await patchInPlace(kh, target.id, wf, enable);
  } catch (err) {
    if (withHttp && isUpgradeRequired(err)) {
      console.log(
        "\n⚠️  The HTTP-Request handoff node needs KeeperHub Pro — falling back to\n" +
          "   the free watcher (Schedule → read HF → Condition). The Guardian is\n" +
          "   triggered out-of-band. Upgrade and re-run with --with-http for the\n" +
          "   in-workflow webhook.\n",
      );
      wf = build(false);
      writeArtifact(wf);
      result = await patchInPlace(kh, target.id, wf, enable);
    } else {
      throw err;
    }
  }

  const replaced = target.name === STUB_NAME ? " (replaced the stub in place)" : "";
  console.log(
    `\n✅ Deployed "${result.name}" (${result.id})${replaced} — ` +
      `${result.enabled ? "ENABLED (schedule live)" : "disabled (enable in the UI or with --enable)"}.`,
  );
  console.log(`   View: https://app.keeperhub.com/workflows/${result.id}`);
}

main().catch((err) => {
  console.error("deploy-workflow error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
