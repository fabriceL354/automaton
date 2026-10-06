/** V9 deterministic lifecycle and integer metrics. No I/O or implicit actions. */
import { LEDGER_LIMITS } from "./economic-ledger.js";
export const PROJECT_LIMITS = Object.freeze({ MAX_ACTIVE_PROJECTS: 2, MAX_PROJECT_BUDGET_CENTS: 1000,
  MAX_BATCH_BUDGET_CENTS: 2000, MAX_EXPERIMENT_DURATION_DAYS: 7, MAX_EVENTS: 256, MAX_BYTES: 1024 * 1024 });
export type AssetStatus = "created" | "active" | "passive_monitoring" | "retired";
export interface ProjectAsset { asset_id: string; status: AssetStatus; created_at: string; retired_at: string | null }
export type Classification = "successful" | "failed" | "inconclusive" | "cancelled";
export function integerCents(value: unknown, signed = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) ||
    value < (signed ? -LEDGER_LIMITS.maxCents : 0) || value > LEDGER_LIMITS.maxCents) throw new Error("Invalid integer cents or overflow");
  return value;
}
export function assetMetrics(expense: number, revenue: number, passive: number) {
  [expense, revenue, passive].forEach(v => integerCents(v));
  const lifetime = integerCents(Number(BigInt(revenue) + BigInt(passive)));
  return { experiment_expense_cents: expense, experiment_revenue_cents: revenue, post_experiment_revenue_cents: passive,
    lifetime_revenue_cents: lifetime, lifetime_net_result_cents: integerCents(Number(BigInt(lifetime) - BigInt(expense)), true) };
}
export function experimentTiming(started: string | null, deadline: string | null, closed: string | null, now: string) {
  return { activity: closed ? "closed" : !started ? "not_started" : now >= deadline! ? "expired" : "active",
    closable: started !== null && closed === null };
}
export function closeAsset(asset: ProjectAsset | null, policy: "keep" | "retire", at: string): ProjectAsset | null {
  if (!asset) { if (policy === "keep") throw new Error("No asset to keep"); return null; }
  if (asset.status === "retired") throw new Error("Asset already retired");
  return { ...asset, status: policy === "keep" ? "passive_monitoring" : "retired", retired_at: policy === "retire" ? at : null };
}
