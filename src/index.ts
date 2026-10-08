#!/usr/bin/env node
/** Entry point for the local-only Scout branch. */
import { loadLocalScoutConfig, runLocalScout } from "./agent/local-runner.js";
import { runOpportunityScout, scoutMode } from "./agent/opportunity-scout.js";
import { runExperimentScout } from "./agent/experiment-runner.js";
import { runApprovalScout, parseApprovalCommand } from "./agent/approval-gate.js";
import { runRevenueScout, parseRevenueCommand } from "./agent/revenue-runner.js";
import { runExternalScout, runExternalApprovalScout, parseExternalCommand } from "./agent/external-gateway.js";
import { runProjectScout, parseProjectCommand } from "./agent/project-manager.js";
import { runMonitoringScout, parseMonitoringCommand } from "./agent/experiment-monitor.js";
import { runLearningScout, parseLearningCommand } from "./agent/economic-learning.js";
import { runLedgerScout } from "./agent/ledger-runner.js";
import { runResearchScout } from "./agent/research-controller.js";
import { CAPABILITY_REGISTRY } from "./agent/capability-registry.js";
import { runAllocationScout, parseAllocationCommand } from "./agent/allocation-runner.js";

const VERSION = "0.12.5";
const HELP = `Scout V12.5 Control API (local-only) v${VERSION}

Usage:
  SCOUT_MODE=control-api automaton [--run]  Local HTTP control, no Ollama/execution
  SCOUT_MODE=allocation automaton --run [--source research|opportunity]
  SCOUT_MODE=allocation automaton --calculate-allocation [--source research|opportunity]
  SCOUT_MODE=allocation automaton --inspect-allocation
  V12: single durable PROPOSAL_ONLY snapshot, offline, no Ollama. NO REAL MONEY WAS SPENT BY V12.
  SCOUT_MODE=research automaton --run  Public research only; fixed default mission or SCOUT_PUBLIC_RESEARCH_MISSION
  SCOUT_MODE=research automaton --inspect-capabilities  Immutable informational registry, offline
  automaton --run          Run Scout from ~/.automaton/scout-workspace/MISSION.txt
  automaton --approve <request_id>  Approve one pending request (SCOUT_MODE=approval)
  automaton --deny <request_id>     Deny one pending request (SCOUT_MODE=approval)
  automaton --new-request           Explicitly create a fresh pending request (approval mode)
  automaton --record-result <experiment_id> --expense-cents <n> --revenue-cents <n> --outcome <success|partial|failed|cancelled> [--approval-request-id <id>] [--preview]
                          Human-confirmed accounting only (SCOUT_MODE=revenue)
  automaton --prepare-webhook-ping  Prepare fixed ping, offline (SCOUT_MODE=external)
  automaton --preview <action_id>   Offline V8 preview
  automaton --inspect               Verify current V8 state, offline
  automaton --approve-external <request_id>  Explicit V6 approval (SCOUT_MODE=approval)
  automaton --deny-external <request_id>     Explicit V6 denial (SCOUT_MODE=approval)
  automaton --execute <action_id> --approval-request-id <request_id> [--preview]
                          One HTTPS POST, at most once (SCOUT_MODE=external)
  automaton --create-batch [--preview]                       (SCOUT_MODE=projects)
  automaton --create-project <batch_id> --name <text> --hypothesis <text> --budget-cents <0..1000> --duration-days <1..7> [--preview]
  automaton --reserve-project <project_id> --experiment-id <id> [--preview]
  automaton --approve-project <project_id> --experiment-id <id> --request-id <id> [--preview]  (SCOUT_MODE=approval)
  automaton --deny-project <project_id> --experiment-id <id> --request-id <id> [--preview]     (SCOUT_MODE=approval)
  automaton --start-project <project_id> --experiment-id <id> --request-id <id> [--preview]
  automaton --cancel-project <project_id> --experiment-id <id> [--preview]
  automaton --create-asset <project_id> --experiment-id <id> [--preview]
  automaton --activate-asset <project_id> --experiment-id <id> --asset-id <id> [--preview]
  automaton --close-experiment <project_id> --experiment-id <id> --request-id <id> --expense-cents <n> --revenue-cents <n> --classification <successful|failed|inconclusive|cancelled> --asset-policy <keep|retire> [--preview]
  automaton --record-passive-revenue <project_id> --experiment-id <id> --asset-id <id> --receipt-id <receipt-UUID> --revenue-cents <n> [--preview]
  automaton --retire-asset <project_id> --experiment-id <id> --asset-id <id> [--preview]
  automaton --link-external-action <project_id> --experiment-id <id> --action-id <id> --request-id <V8_request_id> [--preview]
  automaton --list-projects
  automaton --inspect-project <project_id>
  V8 scoped execute: append --project-id <id> --experiment-id <id> before --preview.
  V9 is local accounting/lifecycle only. NO REAL MONEY IS SPENT BY V9.
  automaton --status <project_id> --experiment-id <id>      (SCOUT_MODE=monitoring)
  automaton --timeline <project_id> --experiment-id <id>
  automaton --record-observation <project_id> --experiment-id <id> --type <enum> <typed fields> [--effective-at <ISO>] [--preview]
  automaton --asset-observation <project_id> --experiment-id <id> --asset-id <id> --type <enum> <typed fields> [--effective-at <ISO>] [--preview]
  automaton --checkpoint <project_id> --experiment-id <id> --checkpoint <start|day_1|day_3|day_5|deadline> [--preview]
  automaton --reconcile-observation <project_id> --experiment-id <id> --observation-id <id> --ledger-entry-id <entry-id> [--preview]
  V10 typed fields: metrics --metric <enum> --value <n>; claims --amount-cents <n>;
  notes --note <text>; asset status --reported-status <available|unavailable|unknown>;
  external_action_result --execution-id <id>. No free JSON, financial writes or network.
  V11 (SCOUT_MODE=learning), deterministic, offline, no Ollama:
  automaton --analyze-project <project_id> --experiment-id <id>
  automaton --learning-report <project_id> --experiment-id <id>
  automaton --analyze-batch <batch_id>
  automaton --analyze-experiment <V7_experiment_id>
  automaton --compare <project_id_A> <project_id_B>
  automaton --list-hypotheses
  automaton --inspect-hypothesis <hypothesis-UUID>
  automaton --create-hypothesis <hypothesis-UUID> --batch-id <id> --statement <text> --rule <inquiries_lifetime|experiment_profitability> [--min-inquiries <1..1000000>] [--preview]
  automaton --refresh-hypothesis <hypothesis-UUID> [--preview]
  automaton --retire-hypothesis <hypothesis-UUID> [--preview]
  NO ACTION IS AUTHORIZED BY THIS REPORT.
  automaton --version      Show version
  automaton --help         Show this help

Scout writes rapport.txt inside ~/.automaton/scout-workspace and exits.
Approval mode verifies V4/V5 and records local authorization only; no model/network/execution.
Ledger mode writes economic-ledger.json and economic-report.txt; no model required.
Install the model with: ollama pull qwen2.5:1.5b-instruct

Environment:
  SCOUT_MODEL             Locally installed model (default: qwen2.5:1.5b-instruct)
  OLLAMA_BASE_URL          Loopback Ollama URL (default: http://127.0.0.1:11434)
  SCOUT_NUM_CTX           Context tokens: 512–8192 (default: 2048)
  SCOUT_NUM_PREDICT       Output tokens: 64–2048 (default: 256)
                          V3.1 caps candidate/detail calls at 128/256
  SCOUT_TIMEOUT_MS        Local inference timeout: 1000–1800000 ms (default: 300000)
  SCOUT_DEBUG_ACTIONS     1 prints rejected raw actions locally (default: 0)
  SCOUT_CONTROL_API_TOKEN  Required operator random token, 32..256 URL-safe characters
  SCOUT_CONTROL_API_HOST   Must be 127.0.0.1 (default)
  SCOUT_CONTROL_API_PORT   0..65535 (default 4317; 0 selects a free port)
  SCOUT_MODE               local (default), opportunity, experiment, ledger, approval, revenue, external, projects, monitoring, learning, research, allocation or control-api; no implicit fallback
  SCOUT_V8_WEBHOOK_URL     Operator public HTTPS:443 URL; no credentials/query/fragment
  SCOUT_INITIAL_CAPITAL_EUR  Ledger initialization only: 0–10000 EUR, max 2 decimals (default: 100)
  SCOUT_BUDGET_EUR         Positive integer budget for opportunity mode (default: 100, max: 10000)
  SCOUT_EXPERIMENT_BUDGET_EUR  Planning ceiling for experiment mode (default: 10, max: 10, never spent)
  SCOUT_COUNTRY            Optional operator-supplied country/context (no geolocation)
  SCOUT_CONTEXT            Optional bounded operator context (no automatic lookup)
  SCOUT_SEARCH_PROVIDER   none (default), brave, searxng, duckduckgo-lite or duckduckgo-html; no automatic fallback
  BRAVE_SEARCH_API_KEY    Runtime-only key for the fixed Brave endpoint; never a mission/prompt
  SCOUT_PUBLIC_RESEARCH_MISSION  Optional explicitly public mission (research mode only)
  SCOUT_SEARXNG_URL       Public HTTPS origin for explicitly selected SearXNG instance
  SCOUT_PUBLIC_QUERIES    JSON array of up to 3 explicitly public search queries
  SCOUT_PUBLIC_URLS       JSON array of up to 5 approved public HTTPS URLs
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!["--help", "-h", "--version", "-v"].includes(args[0]) && process.env.SCOUT_MODE === "control-api") {
    if (args.length && !(args.length === 1 && args[0] === "--run")) throw new Error("Control API accepts no arguments or --run only");
    try { const { runControlApi } = await import("./agent/control-api.js"); await runControlApi(); }
    catch { throw new Error("Control API unavailable; verify local configuration and port. No execution performed."); }
    return;
  }
  if (args.length === 0) {
    console.log(HELP);
    return;
  }
  if (!["--help", "-h", "--version", "-v"].includes(args[0]) && scoutMode() === "allocation") {
    await runAllocationScout({ command: parseAllocationCommand(args), onEvent: message => console.log(message) });
    return;
  }
  if (!["--help", "-h", "--version", "-v"].includes(args[0]) && scoutMode() === "research") {
    if (args.length !== 1) throw new Error("Research accepts exactly --run or --inspect-capabilities");
    if (args[0] === "--inspect-capabilities") { console.log(JSON.stringify(CAPABILITY_REGISTRY, null, 2)); return; }
    if (args[0] !== "--run") throw new Error("Research accepts exactly --run or --inspect-capabilities");
    const output = await runResearchScout({ ...await loadLocalScoutConfig(), onEvent: message => console.log(message) });
    if (output.status !== "PASS") process.exitCode = 2;
    return;
  }
  if (!["--help", "-h", "--version", "-v"].includes(args[0]) && scoutMode() === "learning") {
    await runLearningScout({ command: parseLearningCommand(args), onEvent: message => console.log(message) });
    return;
  }
  if (!["--help", "-h", "--version", "-v"].includes(args[0]) && scoutMode() === "monitoring") {
    await runMonitoringScout({ command: parseMonitoringCommand(args), onEvent: message => console.log(message) });
    return;
  }
  if (!["--help", "-h", "--version", "-v"].includes(args[0]) &&
      (scoutMode() === "projects" || (["--approve-project", "--deny-project"].includes(args[0]) && scoutMode() === "approval"))) {
    await runProjectScout({ command: parseProjectCommand(args), onEvent: message => console.log(message) });
    return;
  }
  if (!["--help", "-h", "--version", "-v"].includes(args[0]) && scoutMode() === "external") {
    await runExternalScout({ command: parseExternalCommand(args), onEvent: message => console.log(message) });
    return;
  }
  if (["--approve-external", "--deny-external"].includes(args[0]) && scoutMode() === "approval") {
    await runExternalApprovalScout({ args, onEvent: message => console.log(message) });
    return;
  }
  if (!["--help", "-h", "--version", "-v"].includes(args[0]) && scoutMode() === "revenue") {
    await runRevenueScout({ command: parseRevenueCommand(args), onEvent: message => console.log(message) });
    return;
  }
  if (!["--help", "-h", "--version", "-v"].includes(args[0]) && scoutMode() === "approval") {
    await runApprovalScout({ command: parseApprovalCommand(args), onEvent: message => console.log(message) });
    return;
  }
  if (args.length !== 1) throw new Error("Use exactly one command: --run, --help or --version");
  switch (args[0]) {
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    case "--version":
    case "-v":
      console.log(`Scout V12.5 Control API (local-only) v${VERSION}`);
      return;
    case "--run": {
      const mode = scoutMode();
      if (mode === "ledger") {
        await runLedgerScout({ onEvent: message => console.log(message) });
        return;
      }
      const config = await loadLocalScoutConfig();
      console.log(`Scout ${mode}: ${config.model} via ${config.baseUrl}`);
      if (mode === "opportunity") {
        await runOpportunityScout({ ...config, onEvent: message => console.log(message) });
      } else if (mode === "experiment") {
        await runExperimentScout({ ...config, onEvent: message => console.log(message) });
      } else {
        await runLocalScout({ ...config, onEvent: message => console.log(message) });
      }
      return;
    }
    default:
      throw new Error("This branch only supports --run, --help and --version; external setup and wallet commands are disabled");
  }
}

main().catch((error: unknown) => {
  console.error(`Scout: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
