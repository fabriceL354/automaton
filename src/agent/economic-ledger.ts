import { domainNow } from "./pilot-context.js";
/** V5 accounting only. No model, network, payment or tool dispatch. */
import { createHash } from "node:crypto";
import {
  parseExperimentActions, parseExperimentCriteria, parseExperimentHypothesis,
  type ExperimentPlan,
} from "./experiment-runner.js";

export const LEDGER_LIMITS = Object.freeze({ maxInitialCents: 1_000_000, maxCents: 1_000_000_000, maxEntries: 1000, maxBytes: 2 * 1024 * 1024 });
export type EntryType = "initialization" | "reserve" | "release" | "expense" | "revenue";
export interface ExperimentReference {
  id: string;
  name: string;
  budget_cents: number;
  requires_real_spending: boolean;
  requires_human_approval: boolean;
}
export interface LedgerEntry {
  id: string;
  type: EntryType;
  amount_cents: number;
  timestamp: string;
  description: string;
  experiment: ExperimentReference | null;
  human_reference: string | null;
  previous_hash: string;
  hash: string;
}
export interface EconomicLedger {
  version: 5;
  currency: "EUR";
  initial_capital_cents: number;
  available_balance_cents: number;
  reserved_balance_cents: number;
  total_recorded_expenses_cents: number;
  total_recorded_revenue_cents: number;
  realized_net_result_cents: number;
  entries: LedgerEntry[];
}

const totalsFields = ["initial_capital_cents", "available_balance_cents", "reserved_balance_cents",
  "total_recorded_expenses_cents", "total_recorded_revenue_cents", "realized_net_result_cents"] as const;
const entryFields = ["id", "type", "amount_cents", "timestamp", "description", "experiment", "human_reference", "previous_hash", "hash"];
const referenceFields = ["id", "name", "budget_cents", "requires_real_spending", "requires_human_approval"];
const genesis = "0".repeat(64);

function object(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== fields.length || Object.keys(data).some(key => !fields.includes(key))) throw new Error(`${label}: unexpected or missing fields`);
  return data;
}
function text(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) throw new Error(`Invalid ${label}`);
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Boolean required");
  return value;
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function cents(value: unknown, min = 0): number {
  return integer(value, min, LEDGER_LIMITS.maxCents, "amount in integer cents");
}
function fromExact(value: bigint, signed = false): number {
  const limit = BigInt(LEDGER_LIMITS.maxCents);
  if (value < (signed ? -limit : 0n) || value > limit) throw new Error("Ledger monetary limit exceeded");
  return Number(value); // Only checked exact integers are persisted as JSON numbers.
}

/** Decimal euros are parsed as digits, never multiplied as floating point. */
export function initialCapitalCents(raw = "100"): number {
  if (!/^(?:0|[1-9][0-9]{0,4})(?:\.[0-9]{1,2})?$/.test(raw)) throw new Error("SCOUT_INITIAL_CAPITAL_EUR must be decimal EUR with at most two decimals");
  const [whole, fraction = ""] = raw.split(".");
  const value = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (value > BigInt(LEDGER_LIMITS.maxInitialCents)) throw new Error("SCOUT_INITIAL_CAPITAL_EUR maximum is 10000 EUR");
  return Number(value);
}
export function formatCents(value: number): string {
  integer(value, -LEDGER_LIMITS.maxCents, LEDGER_LIMITS.maxCents, "money");
  const exact = BigInt(value);
  const absolute = exact < 0n ? -exact : exact;
  return `${exact < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")} EUR`;
}

/** Read V4/V4.1's exact output schema; never interpret proposed actions. */
export function parseLedgerExperiment(raw: string): ExperimentPlan {
  const data = object(JSON.parse(raw), ["version", "status", "opportunity_name", "opportunity_score", "hypothesis", "experiment_budget_eur",
    "duration_days", "actions", "success_metrics", "stop_conditions", "expected_learning", "requires_real_spending",
    "requires_external_account", "requires_publication", "requires_human_approval"], "experiment.json");
  if (data.version !== 4 || data.status !== "planned") throw new Error("A planned V4 experiment is required");
  const criteria = parseExperimentCriteria(JSON.stringify({ duration_days: data.duration_days, success_metrics: data.success_metrics,
    stop_conditions: data.stop_conditions, expected_learning: data.expected_learning, requires_real_spending: data.requires_real_spending,
    requires_external_account: data.requires_external_account, requires_publication: data.requires_publication }));
  const approval = bool(data.requires_human_approval);
  if ((criteria.requires_real_spending || criteria.requires_external_account || criteria.requires_publication) && !approval) throw new Error("Experiment must remain human-approval gated");
  const budget = integer(data.experiment_budget_eur, 0, 10, "experiment budget");
  if (!criteria.requires_real_spending && budget !== 0) throw new Error("Nonspending experiment must have a zero budget");
  return {
    version: 4, status: "planned", opportunity_name: text(data.opportunity_name, 120, "opportunity name"),
    opportunity_score: integer(data.opportunity_score, 0, 100, "score"),
    hypothesis: parseExperimentHypothesis(JSON.stringify({ hypothesis: data.hypothesis })),
    experiment_budget_eur: budget,
    actions: parseExperimentActions(JSON.stringify({ actions: data.actions })), ...criteria,
    requires_human_approval: approval,
  };
}
export function experimentReference(plan: ExperimentPlan): ExperimentReference {
  const validated = parseLedgerExperiment(JSON.stringify(plan));
  return { id: hash(validated), name: validated.opportunity_name,
    budget_cents: Number(BigInt(validated.experiment_budget_eur) * 100n),
    requires_real_spending: validated.requires_real_spending, requires_human_approval: validated.requires_human_approval };
}
function parseReference(value: unknown): ExperimentReference {
  const data = object(value, referenceFields, "experiment reference");
  if (typeof data.id !== "string" || !/^[a-f0-9]{64}$/.test(data.id)) throw new Error("Invalid experiment id");
  const ref = { id: data.id, name: text(data.name, 120, "experiment name"),
    budget_cents: integer(data.budget_cents, 1, 1000, "reserved experiment budget"),
    requires_real_spending: bool(data.requires_real_spending), requires_human_approval: bool(data.requires_human_approval) };
  if (!ref.requires_real_spending || !ref.requires_human_approval) throw new Error("Reservation must remain approval-gated");
  return ref;
}

/** Replay every entry: cached totals and chain are never trusted. */
function replay(entries: LedgerEntry[]): Omit<EconomicLedger, "version" | "currency" | "entries"> {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > LEDGER_LIMITS.maxEntries) throw new Error("Invalid entry count");
  let initial = 0n, available = 0n, reserved = 0n, expenses = 0n, revenue = 0n;
  let previousHash = genesis, previousTime = "";
  const reservations = new Map<string, { remaining: bigint; reference: ExperimentReference }>();
  const humanReferences = new Set<string>();
  entries.forEach((value, index) => {
    const data = object(value, entryFields, "ledger entry");
    if (data.id !== `entry-${String(index + 1).padStart(6, "0")}`) throw new Error("Invalid entry id/order");
    const timestamp = text(data.timestamp, 24, "timestamp");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp || timestamp < previousTime) throw new Error("Invalid timestamp/order");
    if (typeof data.type !== "string" || !["initialization", "reserve", "release", "expense", "revenue"].includes(data.type)) throw new Error("Unknown entry type");
    const type = data.type as EntryType;
    const amount = cents(data.amount_cents, type === "initialization" ? 0 : 1);
    const description = text(data.description, 240, "description");
    const experiment = data.experiment === null ? null : parseReference(data.experiment);
    const human = data.human_reference === null ? null : text(data.human_reference, 120, "human reference");
    if (type === "expense" || type === "revenue" || type === "release") {
      if (!human || humanReferences.has(human)) throw new Error("Unique explicit human authorization/confirmation reference required");
      humanReferences.add(human);
    } else if (human !== null) throw new Error("Unexpected human reference");
    const payload = { id: data.id, type, amount_cents: amount, timestamp, description, experiment, human_reference: human, previous_hash: previousHash };
    if (data.previous_hash !== previousHash || data.hash !== hash(payload)) throw new Error("Ledger integrity chain mismatch");
    const exact = BigInt(amount);
    if (index === 0 && type !== "initialization") throw new Error("Initialization must be first");
    if (type === "initialization") {
      if (index !== 0 || experiment !== null || amount > LEDGER_LIMITS.maxInitialCents) throw new Error("Invalid initialization");
      initial = exact; available = exact;
    } else if (type === "revenue") {
      if (experiment !== null) throw new Error("Revenue must not alter an experiment reservation");
      revenue += exact; available += exact;
    } else {
      if (!experiment) throw new Error("Experiment reference required");
      const reservation = reservations.get(experiment.id);
      if (type === "reserve") {
        if (reservation || amount !== experiment.budget_cents || exact > available) throw new Error("Duplicate or unaffordable reservation");
        reservations.set(experiment.id, { remaining: exact, reference: experiment });
        available -= exact; reserved += exact;
      } else {
        if (!reservation || JSON.stringify(reservation.reference) !== JSON.stringify(experiment) || exact > reservation.remaining) throw new Error("Amount exceeds matching reservation");
        reservation.remaining -= exact; reserved -= exact;
        if (type === "release") available += exact;
        else expenses += exact;
      }
    }
    // Bound every intermediate state as well as the final cached totals.
    for (const total of [available, reserved, expenses, revenue]) fromExact(total);
    previousHash = data.hash as string; previousTime = timestamp;
  });
  return { initial_capital_cents: fromExact(initial), available_balance_cents: fromExact(available), reserved_balance_cents: fromExact(reserved),
    total_recorded_expenses_cents: fromExact(expenses), total_recorded_revenue_cents: fromExact(revenue), realized_net_result_cents: fromExact(revenue - expenses, true) };
}
export function parseEconomicLedger(raw: string): EconomicLedger {
  if (Buffer.byteLength(raw) > LEDGER_LIMITS.maxBytes) throw new Error("Ledger exceeds size limit");
  const data = object(JSON.parse(raw), ["version", "currency", ...totalsFields, "entries"], "ledger");
  if (data.version !== 5 || data.currency !== "EUR") throw new Error("Ledger must be V5 EUR");
  const entries = data.entries as LedgerEntry[];
  const totals = replay(entries);
  for (const field of totalsFields) {
    integer(data[field], field === "realized_net_result_cents" ? -LEDGER_LIMITS.maxCents : 0, LEDGER_LIMITS.maxCents, field);
    if (data[field] !== totals[field]) throw new Error(`Ledger total mismatch: ${field}`);
  }
  return { version: 5, currency: "EUR", ...totals, entries };
}
function append(ledger: EconomicLedger | undefined, type: EntryType, amount: number, description: string,
  experiment: ExperimentReference | null, human: string | null): EconomicLedger {
  const entries = ledger ? parseEconomicLedger(JSON.stringify(ledger)).entries : [];
  const payload = { id: `entry-${String(entries.length + 1).padStart(6, "0")}`, type, amount_cents: amount,
    timestamp: domainNow(), description, experiment, human_reference: human,
    previous_hash: entries.at(-1)?.hash ?? genesis };
  const next = [...entries, { ...payload, hash: hash(payload) }];
  const result: EconomicLedger = { version: 5, currency: "EUR", ...replay(next), entries: next };
  return parseEconomicLedger(JSON.stringify(result));
}
export function initializeLedger(capitalCents: number): EconomicLedger {
  integer(capitalCents, 0, LEDGER_LIMITS.maxInitialCents, "initial capital");
  return append(undefined, "initialization", capitalCents, "Capital comptable local initial ; aucun dépôt bancaire", null, null);
}
export function reserveExperiment(ledger: EconomicLedger, plan: ExperimentPlan): EconomicLedger {
  const current = parseEconomicLedger(JSON.stringify(ledger));
  const ref = experimentReference(plan);
  if (!ref.requires_real_spending || ref.budget_cents === 0) return current;
  // A released/spent reservation is not reopened on rerun. A new plan needs a
  // different canonical content hash; no auto-reservation of the same plan twice.
  if (current.entries.some(entry => entry.type === "reserve" && entry.experiment?.id === ref.id)) return current;
  return append(current, "reserve", ref.budget_cents, "Réservation comptable uniquement ; approbation humaine en attente", ref, null);
}

/** Trusted V9 host adapter: the same V5 reservation/replay rules, unique scoped
 * reference, integer cents. Not exposed as a model tool or generic CLI event. */
export function reserveProjectReference(ledger: EconomicLedger, reference: ExperimentReference): EconomicLedger {
  const current = parseEconomicLedger(JSON.stringify(ledger)), ref = parseReference(reference);
  if (current.entries.some(e => e.type === "reserve" && e.experiment?.id === ref.id)) throw new Error("Duplicate project reservation");
  return append(current, "reserve", ref.budget_cents, "Réservation V9 comptable ; aucun paiement", ref, null);
}

/** Trusted host API only. Not a tool, CLI input, env event, or LLM contract. */
export type AuthorizedLedgerEvent = {
  type: "expense" | "release"; amount_cents: number; experiment_id: string; description: string;
  authorization: { source: "human"; reference: string };
} | {
  type: "revenue"; amount_cents: number; description: string;
  authorization: { source: "human"; reference: string };
};
export function recordAuthorizedEvent(ledger: EconomicLedger, event: AuthorizedLedgerEvent): EconomicLedger {
  const current = parseEconomicLedger(JSON.stringify(ledger));
  const data = object(event, event.type === "revenue" ? ["type", "amount_cents", "description", "authorization"] : ["type", "amount_cents", "experiment_id", "description", "authorization"], "authorized event");
  if (typeof data.type !== "string" || !["expense", "release", "revenue"].includes(data.type)) throw new Error("Invalid authorized event type");
  const authorization = object(data.authorization, ["source", "reference"], "authorization");
  if (authorization.source !== "human") throw new Error("Explicit human authorization required");
  const human = text(authorization.reference, 120, "human reference");
  let ref: ExperimentReference | null = null;
  if (data.type !== "revenue") {
    ref = current.entries.find(entry => entry.type === "reserve" && entry.experiment?.id === data.experiment_id)?.experiment ?? null;
    if (!ref) throw new Error("Unknown experiment reservation");
  }
  return append(current, data.type as EntryType, cents(data.amount_cents, 1), text(data.description, 240, "description"), ref, human);
}

export function buildEconomicReport(ledger: EconomicLedger, plan?: ExperimentPlan): string {
  const current = parseEconomicLedger(JSON.stringify(ledger));
  const lines = ["Scout V5 — mémoire comptable locale (EUR)", "Ce ledger n'est pas un compte bancaire ni une preuve de paiement.",
    `Capital initial : ${formatCents(current.initial_capital_cents)}`, `Solde disponible : ${formatCents(current.available_balance_cents)}`,
    `Montant réservé : ${formatCents(current.reserved_balance_cents)}`, `Dépenses enregistrées : ${formatCents(current.total_recorded_expenses_cents)}`,
    `Revenus enregistrés : ${formatCents(current.total_recorded_revenue_cents)}`, `Résultat net réalisé enregistré : ${formatCents(current.realized_net_result_cents)}`,
    `Nombre d'entrées : ${current.entries.length}`];
  if (plan) {
    const ref = experimentReference(plan);
    lines.push(`Expérience lue : ${ref.name} (${ref.id})`, `Budget proposé : ${formatCents(ref.budget_cents)}`,
      `Approbation humaine : ${ref.requires_human_approval ? "requise ; aucune approbation accordée par la lecture du plan" : "non requise selon le plan"}`);
  }
  for (const entry of current.entries.filter(entry => entry.type === "reserve")) {
    lines.push(`Réservation historique : ${entry.experiment!.name} (${entry.experiment!.id}), ${formatCents(entry.amount_cents)} ; réservation ≠ dépense. Approbation requise avant exécution.`);
  }
  lines.push("Les dépenses et revenus indiqués sont exclusivement des événements comptables explicitement enregistrés.",
    "Aucune dépense ni action externe n'a été exécutée par Scout.");
  return lines.join("\n") + "\n";
}

/** Read-only historical prefix for V7 audit; replay the unchanged V5 invariants. */
export function ledgerPrefix(ledger: EconomicLedger, count: number): EconomicLedger {
  const current = parseEconomicLedger(JSON.stringify(ledger));
  integer(count, 1, current.entries.length, "ledger prefix count");
  const entries = current.entries.slice(0, count);
  return parseEconomicLedger(JSON.stringify({ version: 5, currency: "EUR", ...replay(entries), entries }));
}
