/** V12.5 fixed DTOs. Never return arbitrary workspace text, credentials or paths. */
export const CONTROL_LIMITS = Object.freeze({ bodyBytes: 1024, urlBytes: 512, headerBytes: 8192,
  pageSize: 100, defaultPageSize: 50, events: 1024, eventBytes: 1024 * 1024,
  queue: 8, connections: 32, requestMs: 5000, responseBytes: 256 * 1024 });
export const EVENT_TYPES = ["APPROVAL_REQUIRED", "HUMAN_INTERVENTION_REQUIRED", "OUT_OF_BUDGET_OPPORTUNITY", "TOOL_REQUEST", "PROJECT_UPDATED", "PROJECT_COMPLETED"] as const;
export type EventType = typeof EVENT_TYPES[number];
export const EVENT_MESSAGES: Record<EventType, string> = {
  APPROVAL_REQUIRED: "Review the existing approval request. Authorization does not execute an action.",
  HUMAN_INTERVENTION_REQUIRED: "Human inspection is required in Scout's local runtime.",
  OUT_OF_BUDGET_OPPORTUNITY: "An estimated opportunity exceeds the current budget. No budget or approval was created.",
  TOOL_REQUEST: "A missing tool was proposed for review. No capability was granted.",
  PROJECT_UPDATED: "The canonical project history records an update.",
  PROJECT_COMPLETED: "The canonical experiment history records completion. See the project for its outcome.",
};
export interface AttentionDTO {
  attention_id: string; event_type: EventType; subject_type: "approval" | "project" | "research" | "allocation";
  subject_id: string; source_ref: string; requires_human_action: boolean;
  authority: "authenticated_state" | "informational_research";
}
export interface EventProjection extends AttentionDTO { created_at: string | null; }
export interface ControlEvent extends AttentionDTO {
  schema_version: 1; event_id: string; sequence: number; created_at: string;
  severity: "info" | "warning"; title: EventType; short_message: string;
  payload: { action_authorized: false; capability_granted: false };
}
export class ControlError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function controlId(value: unknown, prefix: "request" | "project"): string {
  if (typeof value !== "string" || !new RegExp(`^${prefix}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`).test(value)) {
    throw new ControlError(400, "INVALID_ID", "An exact runtime identifier is required.");
  }
  return value;
}
export function decimal(value: string, max: number): number {
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    throw new ControlError(400, "INVALID_QUERY", "Invalid integer cursor or limit.");
  }
  return Number(value);
}
