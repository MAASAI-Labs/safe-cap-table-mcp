import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as E from "./engine.js";
import { VERSION } from "./version.js";

function ok(result: { markdown: string } & Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: result.markdown }, { type: "text" as const, text: "```json\n" + JSON.stringify({ ...result, markdown: undefined }, null, 2) + "\n```" }] };
}
function fail(e: unknown) {
  const msg = e instanceof z.ZodError ? "Invalid input:\n" + e.issues.map(i => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n") : (e as Error).message;
  return { isError: true, content: [{ type: "text" as const, text: msg }] };
}
const wrap = <T>(fn: (a: T) => any) => async (a: T) => { try { return ok(fn(a)); } catch (e) { return fail(e); } };

// Shapes are passed loosely (z.any-friendly objects) and fully validated inside the engine,
// so errors are reported as friendly tool errors instead of protocol errors.
const pricedShape = {
  capTable: z.array(z.object({ name: z.string(), shares: z.number(), class: z.string().optional() })).describe("Pre-round fully diluted holders. Use class 'pool' for the unallocated option pool."),
  safes: z.array(z.object({ name: z.string(), amount: z.number(), type: z.enum(["post-money", "pre-money"]).optional(), valuationCap: z.number().optional(), discount: z.number().optional().describe("fraction, 0.2 = 20%"), mfn: z.boolean().optional() })).optional(),
  notes: z.array(z.object({ name: z.string(), principal: z.number(), annualInterestRate: z.number().optional(), daysOutstanding: z.number().optional(), valuationCap: z.number().optional(), discount: z.number().optional(), capType: z.enum(["pre-money", "post-money"]).optional() })).optional(),
  round: z.object({
    roundName: z.string().optional(), preMoneyValuation: z.number().optional(), pricePerShare: z.number().optional(),
    newInvestors: z.array(z.object({ name: z.string(), amount: z.number() })).optional(),
    targetPoolPercent: z.number().optional().describe("unallocated pool as fraction of post-money FD, e.g. 0.1"),
    poolTiming: z.enum(["pre-money", "post-money"]).optional(),
    promisedOptions: z.number().optional().describe("number of options promised to employees; per YC post-money SAFE, only max(0, promisedOptions - existingPool) of any pool increase is included in Company Capitalization"),
    fees: z.object({ placementCashPercent: z.number().optional(), placementEquityPercent: z.number().optional(), placementAgentName: z.string().optional(), fixedCashFees: z.number().optional() }).optional(),
    pricePrecision: z.number().optional(),
  }),
  advisors: z.array(z.object({ name: z.string(), shares: z.number().optional(), percentOfPostFD: z.number().optional(), fromPool: z.boolean().optional() })).optional(),
};

export function createServer() {
  const server = new McpServer({ name: "safe-cap-table-mcp", version: VERSION });
  const ro = { readOnlyHint: true, openWorldHint: false, idempotentHint: true };

  server.registerTool("safe_ownership", {
    title: "SAFE ownership snapshot",
    description: "Implied ownership of post-money SAFEs (amount / post-money cap), combined SAFE dilution, MFN resolution, and optional share estimates. Use before a priced round.",
    inputSchema: { safes: pricedShape.safes.unwrap(), preSafeShares: z.number().optional() }, annotations: ro,
  }, wrap((a: any) => E.safeOwnership(a)));

  server.registerTool("safe_conversion_price", {
    title: "SAFE / note conversion price",
    description: "For one SAFE or note: compare cap price, discount price and round price, return the conversion price (best-of for the holder) and shares.",
    inputSchema: { amount: z.number(), roundPricePerShare: z.number(), valuationCap: z.number().optional(), discount: z.number().optional(), capitalizationShares: z.number().optional() }, annotations: ro,
  }, wrap((a: any) => E.safeConversion(a)));

  server.registerTool("model_priced_round", {
    title: "Model a priced round",
    description: "Full priced-round model: converts all SAFEs (post- and pre-money, cap/discount/MFN) and convertible notes, issues new investor shares at pre-money valuation or fixed price, tops up the option pool (pre- or post-money), applies placement fees (cash and equity) and advisor grants. Returns before/after cap table, per-holder dilution, FD ownership and markdown.",
    inputSchema: pricedShape, annotations: ro,
  }, wrap((a: any) => E.modelPricedRound(a)));

  server.registerTool("model_round_sequence", {
    title: "Model multi-tranche / extension rounds",
    description: "Apply a sequence of events in order: SAFE issuances (e.g. extensions at different caps), notes, priced rounds (which convert outstanding instruments), and tranche closes at fixed price or valuation (milestone tranches). Returns each step and the final cap table vs start.",
    inputSchema: { capTable: pricedShape.capTable, events: z.array(z.record(z.any())).describe("Each event: {type:'safe', safe:{...}} | {type:'note', note:{...}} | {type:'priced_round', round:{...}, advisors?:[...]} | {type:'tranche', name, investors:[{name,amount}], pricePerShare | preMoneyValuation}") }, annotations: ro,
  }, wrap((a: any) => E.modelSequence(a)));

  server.registerTool("compare_pool_timing", {
    title: "Option pool shuffle comparison",
    description: "Run the same round with the option pool top-up in the pre-money vs the post-money, showing price per share and who bears the dilution. Requires round.targetPoolPercent.",
    inputSchema: pricedShape, annotations: ro,
  }, wrap((a: any) => E.comparePoolTiming(a)));

  server.registerTool("explain_methodology", {
    title: "Explain the math",
    description: "Return the documented conventions and formulas this calculator uses.",
    inputSchema: {}, annotations: ro,
  }, async () => ({ content: [{ type: "text" as const, text: E.METHODOLOGY }] }));

  server.registerTool("load_scenario", {
    title: "Load scenario from token",
    description: "Decode and rerun a scenario from a scenarioToken (returned by modeling tools). Validates the token, decodes the input, and runs the appropriate model.",
    inputSchema: { scenarioToken: z.string().min(1).describe("Scenario token from a previous modeling tool result") }, annotations: ro,
  }, wrap((a: any) => E.loadScenario(a)));

  server.registerTool("compare_scenarios", {
    title: "Compare multiple scenarios",
    description: "Compare 2-6 named scenarios side-by-side. Each scenario can be a full model input or a scenario token. Returns a markdown table with holder ownership % per scenario, price per share, post-money valuation, and deltas vs baseline (in percentage points).",
    inputSchema: {
      scenarios: z.array(z.object({
        name: z.string().min(1).describe("Display name for this scenario"),
        scenario: z.union([
          z.object({ type: z.literal("priced_round"), input: z.any().describe("Full model_priced_round input") }),
          z.object({ type: z.literal("sequence"), input: z.any().describe("Full model_round_sequence input") }),
          z.object({ type: z.literal("pool_timing"), input: z.any().describe("Full compare_pool_timing input") }),
          z.object({ type: z.literal("token"), scenarioToken: z.string().describe("Scenario token from a previous result") }),
        ]).describe("Scenario definition: either full input or a token"),
      })).min(2).max(6).describe("2-6 scenarios to compare"),
      baselineName: z.string().optional().describe("Name of the baseline scenario for delta calculations (defaults to first scenario)"),
    }, annotations: ro,
  }, wrap((a: any) => E.compareScenarios(a)));

  server.registerTool("pro_rata", {
    title: "Pro-rata allocation",
    description: "Amount an investor must buy in a new round to keep its current fully diluted ownership (pro-rata right).",
    inputSchema: { currentOwnership: z.number().describe("fraction, 0.08 = 8%"), roundSize: z.number() }, annotations: ro,
  }, wrap((a: any) => E.proRata(a)));

  server.registerTool("fee_schedule", {
    title: "Placement / advisor fee schedule",
    description: "Tiered (marginal) success fee, monthly retainer with optional credit against the success fee, minimum fee, and warrant coverage.",
    inputSchema: { amountRaised: z.number(), tiers: z.array(z.object({ upTo: z.number().nullable(), rate: z.number() })), monthlyRetainer: z.number().optional(), retainerMonths: z.number().optional(), retainerCreditable: z.boolean().optional(), minimumFee: z.number().optional(), warrantCoveragePercent: z.number().optional(), warrantStrikePrice: z.number().optional() }, annotations: ro,
  }, wrap((a: any) => E.feeSchedule(a)));

  server.registerTool("convert_currency", {
    title: "Currency label / FX",
    description: "Format an amount in a currency (ISO code, e.g. NGN, KES, ZAR) using an FX rate (display units per 1 model unit).",
    inputSchema: { amount: z.number(), currency: z.string().optional(), fxRate: z.number().optional() }, annotations: ro,
  }, wrap((a: any) => { const formatted = E.formatMoney(a.amount, a.currency ?? "USD", a.fxRate ?? 1); return { formatted, markdown: formatted }; }));

  return server;
}
