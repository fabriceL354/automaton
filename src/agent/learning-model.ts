/** V11 bounded deterministic data/rules. No model, I/O or executable learning. */
import { exact, hex, uuid, same } from "./project-model.js";
import { integerCents } from "./asset-lifecycle.js";
import { boundedInteger } from "./monitoring-model.js";
export const LEARNING_LIMITS = Object.freeze({ MAX_PROJECTS_ANALYZED_PER_RUN: 2, MAX_HYPOTHESES: 16,
  MAX_EVIDENCE_LINKS: 256, MAX_REPORT_BYTES: 64 * 1024, MAX_HISTORY_ENTRIES: 128, MAX_HISTORY_BYTES: 1024 * 1024, MAX_STATEMENT_CHARS: 500 });
export const LEARNING_NOTICE = "V11 LEARNS FROM AUTHENTICATED LOCAL HISTORY ONLY; NO ACTION IS EXECUTED";
export const NO_AUTHORIZATION = "NO ACTION IS AUTHORIZED BY THIS REPORT.";
export const CONFIDENCE_THRESHOLDS = Object.freeze({ very_low: 2, low: 5, moderate: 20, strong: 50 });
export type Confidence = "insufficient" | "very_low" | "low" | "moderate" | "strong";
export function evidenceLevel(independentSamples: number): Confidence {
  boundedInteger(independentSamples, 10000);
  if (independentSamples >= CONFIDENCE_THRESHOLDS.strong) return "strong";
  if (independentSamples >= CONFIDENCE_THRESHOLDS.moderate) return "moderate";
  if (independentSamples >= CONFIDENCE_THRESHOLDS.low) return "low";
  return independentSamples >= CONFIDENCE_THRESHOLDS.very_low ? "very_low" : "insufficient";
}
export const HYPOTHESIS_STATUSES = ["open", "supported_weakly", "contradicted_weakly", "mixed", "retired"] as const;
export const RECOMMENDATIONS = ["repeat_small", "modify_and_retry", "observe_longer", "avoid_for_now", "insufficient_evidence"] as const;
export type Recommendation = typeof RECOMMENDATIONS[number];
export type HypothesisStatus = typeof HYPOTHESIS_STATUSES[number];
export function strictStatus(v: unknown): HypothesisStatus {
  if (!HYPOTHESIS_STATUSES.includes(v as HypothesisStatus)) throw new Error("Invalid hypothesis status"); return v as HypothesisStatus;
}
export function strictRecommendation(v: unknown): Recommendation {
  if (!RECOMMENDATIONS.includes(v as Recommendation)) throw new Error("Invalid recommendation"); return v as Recommendation;
}
export function statement(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > LEARNING_LIMITS.MAX_STATEMENT_CHARS || /[\x00-\x1f\x7f]/.test(v)) throw new Error("Bounded hypothesis statement required");
  return v;
}
export interface SourcePin { ledger_count: number; ledger_hash: string; project_count: number; project_hash: string;
  observation_count: number; observation_hash: string; revenue_count: number; revenue_hash: string }
export interface EvidenceLink { project_id: string; experiment_id: string; asset_id: string | null; evidence_hash: string;
  inquiries: number | null; experiment_net_cents: number; lifetime_net_cents: number; reason: string }
export interface HypothesisDefinition { hypothesis_id: string; batch_id: string; statement: string;
  rule: "inquiries_lifetime" | "experiment_profitability"; min_inquiries: number | null }
export interface Evaluation { evidence_for: EvidenceLink[]; evidence_against: EvidenceLink[]; missing_project_ids: string[] }
export interface Hypothesis extends HypothesisDefinition { status: HypothesisStatus; evidence_for: EvidenceLink[]; evidence_against: EvidenceLink[];
  confidence: Confidence; sample_size: number; created_at: string; updated_at: string; current_evaluation: Evaluation }
export interface LearningEvent { version: 11; event_id: string; at: string; operation: "create" | "refresh" | "retire";
  definition: HypothesisDefinition; sources: SourcePin; evaluation: Evaluation }
export type LearningCommand =
  { kind: "analyze-project" | "learning-report"; projectId: string; experimentId: string } |
  { kind: "analyze-batch"; batchId: string } | { kind: "analyze-experiment"; experimentId: string } |
  { kind: "compare"; projectA: string; projectB: string } | { kind: "list-hypotheses" } |
  { kind: "inspect-hypothesis"; hypothesisId: string } |
  { kind: "create-hypothesis"; definition: HypothesisDefinition; preview: boolean } |
  { kind: "refresh-hypothesis" | "retire-hypothesis"; hypothesisId: string; preview: boolean };
export function validateDefinition(v: HypothesisDefinition): HypothesisDefinition {
  exact(v, ["hypothesis_id", "batch_id", "statement", "rule", "min_inquiries"]);
  uuid(v.hypothesis_id, "hypothesis"); uuid(v.batch_id, "batch"); statement(v.statement);
  if (v.rule === "inquiries_lifetime") boundedInteger(v.min_inquiries, 1000000, 1);
  else if (v.rule !== "experiment_profitability" || v.min_inquiries !== null) throw new Error("Explicit bounded hypothesis rule required");
  return v;
}
export function parseLearningCommand(args: string[]): LearningCommand {
  const kind = args[0]?.slice(2);
  if (!args[0]?.startsWith("--")) throw new Error("Explicit V11 command required");
  if (kind === "list-hypotheses" && args.length === 1) return { kind };
  if (kind === "analyze-batch" && args.length === 2) return { kind, batchId: uuid(args[1], "batch") };
  if (kind === "analyze-experiment" && args.length === 2) return { kind, experimentId: hex(args[1]) };
  if (kind === "compare" && args.length === 3) {
    const projectA = uuid(args[1], "project"), projectB = uuid(args[2], "project");
    if (projectA === projectB) throw new Error("Two distinct exact projects required"); return { kind, projectA, projectB };
  }
  if (kind === "inspect-hypothesis" && args.length === 2) return { kind, hypothesisId: uuid(args[1], "hypothesis") };
  if ((kind === "analyze-project" || kind === "learning-report") && args.length === 4 && args[2] === "--experiment-id") {
    return { kind, projectId: uuid(args[1], "project"), experimentId: hex(args[3]) };
  }
  if (kind === "refresh-hypothesis" || kind === "retire-hypothesis") {
    if (!(args.length === 2 || (args.length === 3 && args[2] === "--preview"))) throw new Error("Invalid V11 mutation arguments");
    return { kind, hypothesisId: uuid(args[1], "hypothesis"), preview: args.length === 3 };
  }
  if (kind === "create-hypothesis") {
    const hypothesis_id = uuid(args[1], "hypothesis"), fields: Record<string, string> = {}; let preview = false;
    for (let i = 2; i < args.length; i++) {
      const key = args[i];
      if (key === "--preview") { if (preview) throw new Error("Duplicate preview"); preview = true; continue; }
      if (!["--batch-id", "--statement", "--rule", "--min-inquiries"].includes(key) || Object.hasOwn(fields, key) || i + 1 >= args.length) throw new Error("Unknown/duplicate/missing hypothesis argument");
      fields[key] = args[++i];
    }
    const raw = fields["--min-inquiries"];
    if (raw !== undefined && !/^[1-9][0-9]{0,6}$/.test(raw)) throw new Error("Explicit integer threshold required");
    const definition = validateDefinition({ hypothesis_id, batch_id: fields["--batch-id"], statement: fields["--statement"],
      rule: fields["--rule"] as HypothesisDefinition["rule"], min_inquiries: raw === undefined ? null : Number(raw) });
    return { kind, definition, preview };
  }
  throw new Error("Unknown, incomplete or ambiguous V11 command");
}
export function validateLearningCommand(c: LearningCommand): LearningCommand {
  let args: string[];
  switch (c.kind) {
    case "analyze-project": case "learning-report": exact(c, ["kind", "projectId", "experimentId"]); args = [`--${c.kind}`, c.projectId, "--experiment-id", c.experimentId]; break;
    case "analyze-batch": exact(c, ["kind", "batchId"]); args = ["--analyze-batch", c.batchId]; break;
    case "analyze-experiment": exact(c, ["kind", "experimentId"]); args = ["--analyze-experiment", c.experimentId]; break;
    case "compare": exact(c, ["kind", "projectA", "projectB"]); args = ["--compare", c.projectA, c.projectB]; break;
    case "list-hypotheses": exact(c, ["kind"]); args = ["--list-hypotheses"]; break;
    case "inspect-hypothesis": exact(c, ["kind", "hypothesisId"]); args = ["--inspect-hypothesis", c.hypothesisId]; break;
    case "create-hypothesis": {
      exact(c, ["kind", "definition", "preview"]); const d = validateDefinition(c.definition);
      args = ["--create-hypothesis", d.hypothesis_id, "--batch-id", d.batch_id, "--statement", d.statement, "--rule", d.rule,
        ...(d.min_inquiries === null ? [] : ["--min-inquiries", String(d.min_inquiries)]), ...(c.preview ? ["--preview"] : [])]; break;
    }
    case "refresh-hypothesis": case "retire-hypothesis": exact(c, ["kind", "hypothesisId", "preview"]); args = [`--${c.kind}`, c.hypothesisId, ...(c.preview ? ["--preview"] : [])]; break;
    default: throw new Error("Unknown V11 host command");
  }
  if ("preview" in c && typeof c.preview !== "boolean") throw new Error("Strict preview boolean required");
  const parsed = parseLearningCommand(args); if (!same(parsed, c)) throw new Error("Noncanonical V11 command"); return parsed;
}
export function rational(numerator: number | null, denominator: number | null) {
  if (numerator !== null) integerCents(numerator, true);
  if (denominator !== null) integerCents(denominator);
  return numerator === null || denominator === null || denominator === 0 ? null : { numerator, denominator };
}
export function boundedReport(value: unknown): string {
  const output = typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(output) > LEARNING_LIMITS.MAX_REPORT_BYTES) throw new Error("Learning report size limit"); return output;
}
