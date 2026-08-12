import { normalizeExecutionStatus } from "../src/verification.js";

const statuses = [
  ["running", "pending"],
  ["completed", "confirmed"],
  ["reverted", "reverted"],
  ["cancelled", "failed"],
] as const;
for (const [input, expected] of statuses) {
  const actual = normalizeExecutionStatus({ status: input }, "run").status;
  if (actual !== expected) throw new Error(`${input} classified as ${actual}, expected ${expected}`);
}
console.log("Watcher state classification tests passed.");
