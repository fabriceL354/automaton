/** Fictitious offline examples only. Refuses every existing destination. */
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { initializeLedger } from "../dist/agent/economic-ledger.js";
import { parseOpportunityPhases } from "../dist/agent/research-model.js";
import { buildAttentionItems } from "../dist/agent/tool-discovery.js";
import { researchCandidates } from "../dist/agent/allocation-sources.js";
import { digest } from "../dist/agent/project-model.js";
export async function createPreparationExample(root, count = 2) {
  await fs.mkdir(root, { mode: 0o700 }); // no recursive/overwrite
  await fs.mkdir(path.join(root, "evidence"), { mode: 0o700 });
  const names = ["Modèle de suivi pour indépendants", "Service de mise en page de fiches", "Troisième exemple refusé"];
  const evidence = names.slice(0, count).map((_, i) => ({ source_id: `research-source-${i + 1}`, url: `https://example.com/pilot-${i + 1}`, text: "EXEMPLE FICTIF : coût estimé 10 EUR. Demande et revenus inconnus.", query_id: "research-query-1", round: 1 }));
  const opportunities = names.slice(0, count).map((name, i) => parseOpportunityPhases({ name, kind: i === 0 ? "DURABLE_ASSET" : "QUICK_SERVICE", source_index: i },
    JSON.stringify({ summary: "Exemple pédagogique fictif", estimated_cost_cents: 1000, cost_basis: "SOURCE_ESTIMATE", human_minutes_daily: 20, account_required: false }),
    JSON.stringify({ market: `Marché fictif ${i + 1}`, platform: `Canal fictif ${i + 1}`, fees: "À vérifier", quote: evidence[i].text }),
    JSON.stringify({ risks: ["Demande inconnue"], reason_surfaced: "Comparer deux essais limités sans lancement ni transaction.", mini_test_possible: true, mini_test_cost_cents: 1000, mini_test_description: "Relecture manuelle et retours clients" }), evidence, i));
  const research = { version: "11.1", status: "PASS", reason: "SOURCED_RESEARCH_ONLY_COSTS_AND_REVENUE_UNCONFIRMED", execution_budget_cents: 1000, research_horizon_cents: 10000,
    queries: [], evidence, opportunities, tool_requests: [], capabilities: [], operator_attention: buildAttentionItems(opportunities, [], false), metrics: {},
    security: { project_created: false, approval_created: false, external_action_executed: false, money_spent: false, capability_granted: false, installation_performed: false } };
  const candidates = researchCandidates(JSON.stringify(research));
  const dossiers = [];
  for (const [i, c] of candidates.entries()) {
    const quote = `EXEMPLE FICTIF ${i + 1} : devis de prestation, maximum 1000 centimes, aucun paiement.\n`;
    const market = `EXEMPLE FICTIF ${i + 1} : public cible indépendant, validation commerciale à réaliser.\n`;
    const file = `evidence/quote-${i + 1}.txt`, marketFile = `evidence/market-${i + 1}.txt`;
    await fs.writeFile(path.join(root, file), quote, { mode: 0o600 }); await fs.writeFile(path.join(root, marketFile), market, { mode: 0o600 });
    dossiers.push({ opportunity_id: c.opportunity_id, candidate_fingerprint: c.fingerprint, fictional: true,
      description: c.title, target_customers: "Indépendants, segment fictif", offer: i === 0 ? "Modèle numérique" : "Mise en page manuelle",
      budget_cents: 1000, duration_days: 7, review_expires_at: new Date(Date.now() + 6 * 86400000).toISOString(), estimated_revenue_cents: 1500,
      commercial_uncertainties: ["Aucune vente ni intention d'achat confirmée"], operational_risks: ["Temps de réalisation incertain"],
      success_conditions: ["Trois retours clients documentés", "Une intention d'achat documentée"], stop_conditions: ["Sept jours atteints", "Budget maximum atteint", "Absence de demande"],
      proofs: [{ proof_id: `quote-${i + 1}`, file, sha256: digest(quote), purpose: "cost", public_url: evidence[i].url }, { proof_id: `market-${i + 1}`, file: marketFile, sha256: digest(market), purpose: "market", public_url: evidence[i].url }],
      human_actions: [{ action_id: `manual-service-${i + 1}`, kind: "manual_payment", description: "Évaluer puis régler manuellement une prestation ponctuelle",
        supplier: "Prestataire fictif", beneficiary: "Prestataire fictif", max_amount_cents: 1000, justification: "Essai limité pour obtenir des retours", risks: ["Aucune garantie de vente"], proof_ids: [`quote-${i + 1}`] }] });
  }
  for (const [name, value] of [["research.json", research], ["pilot-preparation-input.json", { version: "12.7", source: "research.json", dossiers }], ["economic-ledger.json", initializeLedger(10000)]]) await fs.writeFile(path.join(root, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  return { root, dossiers, candidates };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "scout-v12-7-example-")), root = path.join(parent, "workspace");
  await createPreparationExample(root);
  console.log(`Fictitious offline example: ${root}`);
  console.log("10000 cents reference only; two 1000-cent preparation budgets; no real expense, revenue or launch.");
}
