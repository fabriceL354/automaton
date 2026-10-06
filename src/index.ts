#!/usr/bin/env node
/** Entry point for the local-only Scout branch. */
import { loadLocalScoutConfig, runLocalScout } from "./agent/local-runner.js";
import { runOpportunityScout, scoutMode } from "./agent/opportunity-scout.js";
import { runExperimentScout } from "./agent/experiment-runner.js";
import { runApprovalScout, parseApprovalCommand } from "./agent/approval-gate.js";
import { runRevenueScout, parseRevenueCommand } from "./agent/revenue-runner.js";
import { runExternalScout, runExternalApprovalScout, parseExternalCommand } from "./agent/external-gateway.js";
import { runLedgerScout } from "./agent/ledger-runner.js";

const VERSION = "0.8.0";
const HELP = `Scout V8 External Action Gateway (local-only) v${VERSION}

Usage:
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
  SCOUT_MODE               local (default), opportunity, experiment, ledger, approval, revenue or external; no implicit fallback
  SCOUT_V8_WEBHOOK_URL     Operator public HTTPS:443 URL; no credentials/query/fragment
  SCOUT_INITIAL_CAPITAL_EUR  Ledger initialization only: 0–10000 EUR, max 2 decimals (default: 100)
  SCOUT_BUDGET_EUR         Positive integer budget for opportunity mode (default: 100, max: 10000)
  SCOUT_EXPERIMENT_BUDGET_EUR  Planning ceiling for experiment mode (default: 10, max: 10, never spent)
  SCOUT_COUNTRY            Optional operator-supplied country/context (no geolocation)
  SCOUT_CONTEXT            Optional bounded operator context (no automatic lookup)
  SCOUT_SEARCH_PROVIDER   none (default), searxng, duckduckgo-lite or duckduckgo-html; no automatic fallback
  SCOUT_SEARXNG_URL       Public HTTPS origin for explicitly selected SearXNG instance
  SCOUT_PUBLIC_QUERIES    JSON array of up to 3 explicitly public search queries
  SCOUT_PUBLIC_URLS       JSON array of up to 5 approved public HTTPS URLs
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(HELP);
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
      console.log(`Scout V8 External Action Gateway (local-only) v${VERSION}`);
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
