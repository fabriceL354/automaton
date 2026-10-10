/** V14.1: pure fictitious arithmetic. Deliberately no imports, I/O, clock,
 * randomness, workspace, financial authority, authenticated learning or approvals. */
export const SIMULATION_LIMITS = Object.freeze({
  MAX_SCENARIOS: 3,
  MAX_UNITS: 10_000,
  MAX_CENTS: 1_000_000_000,
  MAX_ID_CHARS: 48,
});
export const SIMULATION_NOTICE = "FICTIONAL ASSUMPTIONS ONLY; NOT REAL EVIDENCE, AUTHENTICATED LEARNING OR AUTHORIZATION";

export interface FictionalScenario {
  scenario_id: string;
  budget_cents: number;
  fixed_cost_cents: number;
  unit_cost_cents: number;
  unit_price_cents: number;
  units: number;
}
export interface FictionalSimulationInput {
  version: "14.1";
  kind: "FICTIONAL_SIMULATION";
  currency: "EUR";
  scenarios: FictionalScenario[];
}
export interface FictionalScenarioResult {
  input: FictionalScenario;
  hypothetical_variable_cost_cents: number;
  hypothetical_total_cost_cents: number;
  hypothetical_revenue_cents: number;
  hypothetical_net_result_cents: number;
  unit_margin_cents: number;
  exceeds_fictional_budget: boolean;
  break_even: {
    units: number | null;
    revenue_cents: number | null;
    reason: "FINITE" | "ALWAYS_BREAK_EVEN" | "NON_POSITIVE_MARGIN" | "OUTSIDE_LIMITS";
  };
}
export interface FictionalSimulationReport {
  version: "14.1";
  kind: "FICTIONAL_SIMULATION";
  currency: "EUR";
  model: "CONSTANT_UNIT_PRICE_AND_COST_NO_TAX_OR_FINANCING";
  scenarios: FictionalScenarioResult[];
  fictional: true;
  real_evidence: false;
  authenticated_learning_eligible: false;
  action_authorized: false;
  execution_allowed: false;
  financial_transfer_performed: false;
  money_moved_cents: 0;
  available_funds_increase_cents: 0;
  notice: string;
}

// Accept plain data only. In particular, never invoke an accessor while validating.
function exactData(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SIMULATION_INVALID_FIELDS");
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null) || keys.length !== fields.length ||
    keys.some(k => typeof k !== "string" || !fields.includes(k))) throw new Error("SIMULATION_INVALID_FIELDS");
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("SIMULATION_INVALID_FIELDS");
    data[field] = descriptor.value;
  }
  return data;
}
function integer(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < 0 || value > maximum)
    throw new Error("SIMULATION_INVALID_INTEGER");
  return value;
}
function scenario(value: unknown): FictionalScenario {
  const d = exactData(value, ["scenario_id", "budget_cents", "fixed_cost_cents", "unit_cost_cents", "unit_price_cents", "units"]);
  if (typeof d.scenario_id !== "string" || d.scenario_id.length > SIMULATION_LIMITS.MAX_ID_CHARS || !/^[a-z][a-z0-9-]*$/.test(d.scenario_id))
    throw new Error("SIMULATION_INVALID_ID");
  return {
    scenario_id: d.scenario_id,
    budget_cents: integer(d.budget_cents, SIMULATION_LIMITS.MAX_CENTS),
    fixed_cost_cents: integer(d.fixed_cost_cents, SIMULATION_LIMITS.MAX_CENTS),
    unit_cost_cents: integer(d.unit_cost_cents, SIMULATION_LIMITS.MAX_CENTS),
    unit_price_cents: integer(d.unit_price_cents, SIMULATION_LIMITS.MAX_CENTS),
    units: integer(d.units, SIMULATION_LIMITS.MAX_UNITS),
  };
}
function parseInput(value: unknown): FictionalScenario[] {
  const d = exactData(value, ["version", "kind", "currency", "scenarios"]);
  if (d.version !== "14.1" || d.kind !== "FICTIONAL_SIMULATION" || d.currency !== "EUR") throw new Error("SIMULATION_INVALID_SCHEMA");
  const items = d.scenarios;
  if (!Array.isArray(items) || Object.getPrototypeOf(items) !== Array.prototype || items.length < 1 ||
    items.length > SIMULATION_LIMITS.MAX_SCENARIOS || Reflect.ownKeys(items).length !== items.length + 1)
    throw new Error("SIMULATION_SCENARIO_LIMIT");
  const parsed: FictionalScenario[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(items, String(i));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("SIMULATION_INVALID_FIELDS");
    const s = scenario(descriptor.value);
    if (ids.has(s.scenario_id)) throw new Error("SIMULATION_DUPLICATE_ID");
    ids.add(s.scenario_id); parsed.push(s);
  }
  // ASCII identifiers: explicit comparison avoids locale-dependent ordering.
  return parsed.sort((a, b) => a.scenario_id < b.scenario_id ? -1 : a.scenario_id > b.scenario_id ? 1 : 0);
}
const MAX_CENTS = BigInt(SIMULATION_LIMITS.MAX_CENTS);
function cents(value: bigint): number {
  if (value < -MAX_CENTS || value > MAX_CENTS) throw new Error("SIMULATION_RESULT_OVERFLOW");
  return Number(value);
}
function calculate(input: FictionalScenario): FictionalScenarioResult {
  const fixed = BigInt(input.fixed_cost_cents), variable = BigInt(input.unit_cost_cents), price = BigInt(input.unit_price_cents);
  const count = BigInt(input.units), margin = price - variable;
  const totalVariable = variable * count, totalCost = fixed + totalVariable, revenue = price * count;
  // Every monetary result is independently bounded. Do not clip a loss/cost.
  const hypothetical_variable_cost_cents = cents(totalVariable);
  const hypothetical_total_cost_cents = cents(totalCost);
  const hypothetical_revenue_cents = cents(revenue);
  const hypothetical_net_result_cents = cents(revenue - totalCost);
  let break_even: FictionalScenarioResult["break_even"];
  if (margin === 0n && fixed === 0n) {
    break_even = { units: 0, revenue_cents: 0, reason: "ALWAYS_BREAK_EVEN" };
  } else if (margin <= 0n) {
    // No profitable sales volume; a zero-volume balance is not a viable threshold.
    break_even = { units: null, revenue_cents: null, reason: "NON_POSITIVE_MARGIN" };
  } else {
    const units = (fixed + margin - 1n) / margin; // exact ceiling division
    const thresholdRevenue = units * price, thresholdCost = fixed + units * variable;
    break_even = units > BigInt(SIMULATION_LIMITS.MAX_UNITS) || thresholdRevenue > MAX_CENTS || thresholdCost > MAX_CENTS
      ? { units: null, revenue_cents: null, reason: "OUTSIDE_LIMITS" }
      : { units: Number(units), revenue_cents: Number(thresholdRevenue), reason: "FINITE" };
  }
  return { input, hypothetical_variable_cost_cents, hypothetical_total_cost_cents,
    hypothetical_revenue_cents, hypothetical_net_result_cents, unit_margin_cents: cents(margin),
    exceeds_fictional_budget: totalCost > BigInt(input.budget_cents), break_even };
}

/** Comparable rows sorted by scenario_id; no state is read or written. Inputs
 * are copied and strictly checked even when callers bypass the TypeScript types. */
export function simulateFictionalScenarios(input: unknown): FictionalSimulationReport {
  const scenarios = parseInput(input).map(calculate);
  return {
    version: "14.1", kind: "FICTIONAL_SIMULATION", currency: "EUR",
    model: "CONSTANT_UNIT_PRICE_AND_COST_NO_TAX_OR_FINANCING", scenarios,
    fictional: true, real_evidence: false, authenticated_learning_eligible: false,
    action_authorized: false, execution_allowed: false, financial_transfer_performed: false,
    money_moved_cents: 0, available_funds_increase_cents: 0, notice: SIMULATION_NOTICE,
  };
}
