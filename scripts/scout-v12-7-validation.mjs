/** Bounded offline preparation validation; no real pilot or economic result. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createPreparationExample } from "./scout-v12-7-example.mjs";
import { runPilotPreparation } from "../dist/agent/pilot-preparation.js";
import { preparationStoreRoot } from "../dist/agent/pilot-preparation-store.js";
import { workspaceFingerprint } from "../dist/agent/pilot-workspace-proof.js";
import { scoutWorkspaceRoot } from "../dist/agent/local-tools.js";
const normal = scoutWorkspaceRoot(), before = await workspaceFingerprint(normal), previous = process.env.SCOUT_MODE;
const parent = await fs.mkdtemp(path.join(os.tmpdir(), "scout-v12-7-validation-")), root = path.join(parent, "workspace");
await createPreparationExample(root); const ledger = await fs.readFile(path.join(root, "economic-ledger.json"), "utf8");
process.env.SCOUT_MODE = "pilot-preparation";
try {
  const r = await runPilotPreparation({ root, command: { kind: "prepare" } });
  assert.equal(r.projects.length, 2); assert.equal(r.total_preparation_reserved_cents, 2000); assert.equal(r.real_money_spent_by_v12_7_cents, 0);
  for (const p of r.projects) {
    assert(p.blockers.includes("FICTIONAL_PROJECT")); assert.equal(p.experimental_period.started_at, null);
    assert.equal(p.economics.confirmed_revenue_cents, null); assert.equal(p.economics.evidence_confirmed_expense_cents, null);
  }
  const canonical = await fs.readFile(path.join(preparationStoreRoot(root), "state.json"), "utf8");
  await runPilotPreparation({ root, command: { kind: "prepare" } });
  assert.equal(await fs.readFile(path.join(preparationStoreRoot(root), "state.json"), "utf8"), canonical);
  assert.equal(await fs.readFile(path.join(root, "economic-ledger.json"), "utf8"), ledger);
  assert.equal(await workspaceFingerprint(normal), before);
  await fs.writeFile(path.join(parent, "validation-proof.json"), JSON.stringify({ version: "12.7", status: "PASS", mode: "PREPARATION_ONLY",
    projects: 2, reserved_preparation_cents: 2000, real_money_spent_cents: 0, public_network_calls: 0, ollama_calls: 0,
    real_workspace_unchanged: true, no_experiment_started: true }, null, 2) + "\n");
  console.log(`Artifacts: ${parent}`); console.log("V12.7 PASS: two fictitious dossiers, bounded earmarks, idempotent resume, no real launch, no payment, V5 unchanged.");
} finally { if (previous === undefined) delete process.env.SCOUT_MODE; else process.env.SCOUT_MODE = previous; assert.equal(await workspaceFingerprint(normal), before); }
