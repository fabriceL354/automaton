#!/usr/bin/env node
/** Entry point for the local-only Scout branch. */
import { loadLocalScoutConfig, runLocalScout } from "./agent/local-runner.js";
import { runOpportunityScout, scoutMode } from "./agent/opportunity-scout.js";

const VERSION = "0.3.0";
const HELP = `Scout V3 Opportunity Scout v${VERSION}

Usage:
  automaton --run          Run Scout from ~/.automaton/scout-workspace/MISSION.txt
  automaton --version      Show version
  automaton --help         Show this help

Scout writes rapport.txt inside ~/.automaton/scout-workspace and exits.
Install the model with: ollama pull qwen2.5:1.5b-instruct

Environment:
  SCOUT_MODEL             Locally installed model (default: qwen2.5:1.5b-instruct)
  OLLAMA_BASE_URL          Loopback Ollama URL (default: http://127.0.0.1:11434)
  SCOUT_NUM_CTX           Context tokens: 512–8192 (default: 2048)
  SCOUT_NUM_PREDICT       Output tokens: 64–2048 (default: 256)
  SCOUT_TIMEOUT_MS        Local inference timeout: 1000–1800000 ms (default: 300000)
  SCOUT_DEBUG_ACTIONS     1 prints rejected raw actions locally (default: 0)
  SCOUT_MODE               local (default) or opportunity; no implicit fallback
  SCOUT_BUDGET_EUR         Positive integer budget for opportunity mode (default: 100, max: 10000)
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
  if (args.length !== 1) throw new Error("Use exactly one command: --run, --help or --version");
  switch (args[0]) {
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    case "--version":
    case "-v":
      console.log(`Scout V3 Opportunity Scout v${VERSION}`);
      return;
    case "--run": {
      const config = await loadLocalScoutConfig();
      const mode = scoutMode();
      console.log(`Scout ${mode}: ${config.model} via ${config.baseUrl}`);
      if (mode === "opportunity") {
        await runOpportunityScout({ ...config, onEvent: message => console.log(message) });
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
