/** Explicit V12 offline CLI host. No Ollama, finance writer or external dispatcher. */
import path from "node:path";
import { scoutWorkspaceRoot } from "./local-tools.js";
import { scoutMode } from "./opportunity-scout.js";
import { locked } from "./ledger-runner.js";
import { canonicalHash, same, structured, exact, time } from "./project-model.js";
import { historicalSources } from "./evidence-builder.js";
import { readAllocationSources, approvalPins, type AllocationSources } from "./allocation-sources.js";
import { calculateAllocation, allocationFingerprint } from "./capital-allocator.js";
import { loadAllocation, saveAllocation, type AllocationState } from "./allocation-store.js";

export type AllocationCommand = { kind: "calculate"; input: AllocationSources["input_file"] } | { kind: "inspect" };
export function parseAllocationCommand(args: string[]): AllocationCommand {
  if (args.length === 1 && args[0] === "--inspect-allocation") return { kind: "inspect" };
  if ((args[0] === "--run" || args[0] === "--calculate-allocation") && (args.length === 1 || args.length === 3 && args[1] === "--source" && ["research", "opportunity"].includes(args[2]))) {
    return { kind: "calculate", input: args[2] === "opportunity" ? "opportunities.json" : "research.json" };
  }
  throw new Error("Allocation accepts --run / --calculate-allocation [--source research|opportunity] or --inspect-allocation only");
}
function validateCommand(c: AllocationCommand) {
  if (c.kind === "inspect") exact(c, ["kind"]);
  else if (c.kind === "calculate") { exact(c, ["kind", "input"]); if (!["research.json", "opportunities.json"].includes(c.input)) throw new Error("Fixed allocation source required"); }
  else throw new Error("Explicit allocation command required");
}
export function verifyPrefixes(state: AllocationState, sources: AllocationSources) {
  historicalSources(sources.financial, state.proposal.sources);
  const pins = approvalPins(sources.approvals ?? []);
  if (sources.learning_events.length < state.learning_count || canonicalHash(sources.learning_events.slice(0, state.learning_count)) !== state.learning_prefix_hash ||
    pins.requests.length < state.approval_count || canonicalHash(pins.requests.slice(0, state.approval_count)) !== state.approval_prefix_hash ||
    pins.decisions.length < state.approval_decision_count || canonicalHash(pins.decisions.slice(0, state.approval_decision_count)) !== state.approval_decision_hash) throw new Error("Allocation authenticated source rollback or rewrite");
}
export async function runAllocationScout(options: { root?: string; command: AllocationCommand; now?: () => string; onEvent?: (s: string) => void }) {
  if (scoutMode() !== "allocation") throw new Error("Allocation requires SCOUT_MODE=allocation");
  validateCommand(options.command);
  const root = path.resolve(options.root ?? scoutWorkspaceRoot());
  return locked(root, async () => {
    const loaded = await loadAllocation(root);
    if (options.command.kind === "inspect" && !loaded.state) throw new Error("No authenticated allocation proposal exists");
    const input = options.command.kind === "calculate" ? options.command.input : loaded.state!.proposal.input_file;
    const sources = await readAllocationSources(root, input);
    if (loaded.state) verifyPrefixes(loaded.state, sources);
    const current = allocationFingerprint(sources);
    const now = time((options.now ?? (() => new Date().toISOString()))());
    if (loaded.state && now < loaded.state.proposal.generated_at) throw new Error("Allocation clock rollback");
    const expiredSinceProposal = sources.financial.model.projects.some(p => p.status === "active" && p.experiment_deadline! <= now && p.experiment_deadline! > (loaded.state?.proposal.generated_at ?? ""));
    const stale = loaded.state !== undefined && (loaded.state.proposal.source_state_fingerprint !== current || expiredSinceProposal);
    if (options.command.kind === "inspect" || loaded.state && !stale) {
      const result = { proposal: loaded.state!.proposal, stale, new_attention_items: [], notice: "INSPECTION_IS_NOT_AN_APPROVAL; STALE_PROPOSALS_REQUIRE_RECALCULATION" };
      options.onEvent?.(structured(result)); return result;
    }
    const proposal = calculateAllocation(sources, now), previousIds = loaded.state?.seen_attention_ids ?? [];
    const newItems = proposal.attention_items.filter(i => !previousIds.includes(i.attention_id));
    const seen = [...new Set([...previousIds, ...newItems.map(i => i.attention_id)])];
    const pins = approvalPins(sources.approvals ?? []);
    const next: AllocationState = { version: 12, workspace: root, phase: "complete", proposal, seen_attention_ids: seen,
      learning_count: sources.learning_events.length, learning_prefix_hash: canonicalHash(sources.learning_events),
      approval_count: pins.requests.length, approval_prefix_hash: canonicalHash(pins.requests),
      approval_decision_count: pins.decisions.length, approval_decision_hash: canonicalHash(pins.decisions) };
    const verify = async () => { if (!same(await readAllocationSources(root, input), sources)) throw new Error("Allocation sources changed during operation"); };
    await saveAllocation(root, loaded, next, verify);
    const result = { proposal, stale: false, new_attention_items: newItems, notice: "PROPOSAL_ONLY; NO APPROVAL OR EXECUTION AUTHORITY" };
    options.onEvent?.(structured(result)); return result;
  });
}
