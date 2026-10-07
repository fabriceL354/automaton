/** Informational inventory, never a grant or executable tool registry. */
export const CAPABILITY_STATUSES = Object.freeze(["AVAILABLE", "UNAVAILABLE", "PROPOSABLE", "APPROVAL_REQUIRED"] as const);
export const RISK_CLASSES = Object.freeze(["low", "medium", "high", "forbidden"] as const);
export const CAPABILITY_ORIGINS = Object.freeze(["LOCAL_RUNTIME", "CONTROLLED_WEB", "SUPERVISED_RUNTIME", "MISSING", "FORBIDDEN"] as const);
export interface CapabilityDefinition {
  readonly capability_id: string;
  readonly status: typeof CAPABILITY_STATUSES[number];
  readonly risk_class: typeof RISK_CLASSES[number];
  readonly origin: typeof CAPABILITY_ORIGINS[number];
  readonly allowed_operations: readonly string[];
  readonly requires_human_approval: boolean;
  readonly network_access: boolean;
  readonly credential_access: boolean;
  readonly financial_access: boolean;
}
function define(id: string, status: CapabilityDefinition["status"], risk: CapabilityDefinition["risk_class"],
  origin: CapabilityDefinition["origin"], operations: string[], approval = false, network = false, credentials = false, financial = false): CapabilityDefinition {
  return Object.freeze({ capability_id: id, status, risk_class: risk, origin, allowed_operations: Object.freeze(operations),
    requires_human_approval: approval, network_access: network, credential_access: credentials, financial_access: financial });
}
export const CAPABILITY_REGISTRY: readonly CapabilityDefinition[] = Object.freeze([
  define("local_files", "AVAILABLE", "low", "LOCAL_RUNTIME", ["confined_files"]),
  define("local_llm", "AVAILABLE", "low", "LOCAL_RUNTIME", ["bounded_local_inference"]),
  define("web_search", "AVAILABLE", "low", "CONTROLLED_WEB", ["guarded_public_search"], false, true, true),
  define("read_public_page", "AVAILABLE", "low", "CONTROLLED_WEB", ["safe_public_https_get"], false, true),
  define("economic_ledger", "AVAILABLE", "medium", "SUPERVISED_RUNTIME", ["explicit_local_accounting"], true, false, false, true),
  define("approval_gate", "AVAILABLE", "high", "SUPERVISED_RUNTIME", ["explicit_human_decision"], true),
  define("external_gateway", "APPROVAL_REQUIRED", "high", "SUPERVISED_RUNTIME", ["V8_fixed_webhook_ping"], true, true),
  define("projects", "AVAILABLE", "medium", "SUPERVISED_RUNTIME", ["explicit_V9_lifecycle"], true, false, false, true),
  define("monitoring", "AVAILABLE", "low", "SUPERVISED_RUNTIME", ["explicit_V10_local_observation"]),
  define("economic_learning", "AVAILABLE", "low", "SUPERVISED_RUNTIME", ["explicit_V11_local_analysis"]),
  ...["trend_analysis", "image_generation", "pdf_processing", "spreadsheet_analysis", "hosting", "analytics", "video_generation", "translation", "ocr", "specialized_api"]
    .map(id => define(id, "PROPOSABLE", "medium", "MISSING", [], true)),
  ...["email", "marketplace_publish", "interactive_browser"].map(id => define(id, "PROPOSABLE", "high", "MISSING", [], true)),
  define("payment", "UNAVAILABLE", "forbidden", "FORBIDDEN", [], true, false, false, true),
]);
export function capability(id: string): CapabilityDefinition | undefined { return CAPABILITY_REGISTRY.find(c => c.capability_id === id); }
export function parseCapabilityDefinition(value: unknown): CapabilityDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid capability");
  const d = value as Record<string, unknown>, expected = capability(String(d.capability_id));
  if (!expected || !CAPABILITY_STATUSES.includes(d.status as any) || !RISK_CLASSES.includes(d.risk_class as any) ||
      !CAPABILITY_ORIGINS.includes(d.origin as any) || Object.keys(d).length !== Object.keys(expected).length ||
      Object.keys(d).some(k => !Object.hasOwn(expected, k) || JSON.stringify(d[k]) !== JSON.stringify(expected[k as keyof CapabilityDefinition]))) throw new Error("Immutable capability definition mismatch");
  return expected;
}
