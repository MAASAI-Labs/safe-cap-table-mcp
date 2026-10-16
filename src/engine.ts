/**
 * Deterministic SAFE / convertible note / priced-round cap table engine.
 *
 * Conventions (see README "Methodology"):
 * - All share counts are "fully diluted": issued shares + granted options + unallocated pool.
 * - Post-money SAFE (YC 2018+): cap price = postMoneyCap / CompanyCapitalization, where
 *   CompanyCapitalization = all pre-round shares + options + pool + ALL shares issued on
 *   conversion of SAFEs/notes. Any pre-money pool increase is included only to the extent
 *   that promisedOptions exceeds the pre-existing pool (per YC SAFE definition).
 *   New-money shares are excluded.
 * - Pre-money SAFE / notes: cap price = valuationCap / pre-round fully diluted capitalization
 *   (excluding all converting securities and any new pool increase).
 * - Discount price = round price x (1 - discount). Conversion price = lowest applicable price
 *   (cap and discount "best of" for the holder). Uncapped, no-discount SAFEs convert at round price.
 * - MFN SAFEs adopt the most favourable cap (lowest) and discount (highest) among SAFEs listed AFTER them.
 * - The round is solved by fixed-point iteration (circular: price depends on conversion shares
 *   and pool top-up, which depend on price). Converges to < 1e-9 shares.
 * - Final share counts are rounded DOWN to whole shares per holder (YC convention);
 *   price per share is reported unrounded and rounded to `pricePrecision` decimals.
 */
import { z } from "zod";
import { deflateSync, inflateSync } from "zlib";

export const HolderSchema = z.object({
  name: z.string().min(1),
  shares: z.number().nonnegative(),
  class: z.string().min(1).default("common").describe("common, preferred, options, pool, or any custom label (kept through sequences)"),
});
export const SafeSchema = z
  .object({
    name: z.string().min(1),
    amount: z.number().positive(),
    type: z.enum(["post-money", "pre-money"]).default("post-money"),
    valuationCap: z.number().positive().optional(),
    discount: z.number().min(0).lt(1).optional().describe("e.g. 0.2 for 20%"),
    mfn: z.boolean().default(false),
  });
export const NoteSchema = z.object({
  name: z.string().min(1),
  principal: z.number().positive(),
  annualInterestRate: z.number().min(0).max(1).default(0),
  daysOutstanding: z.number().int().nonnegative().default(0),
  valuationCap: z.number().positive().optional(),
  discount: z.number().min(0).lt(1).optional(),
  capType: z.enum(["pre-money", "post-money"]).default("pre-money"),
});
export const InvestorSchema = z.object({ name: z.string().min(1), amount: z.number().positive() });
export const AdvisorSchema = z.object({
  name: z.string().min(1),
  shares: z.number().positive().optional(),
  percentOfPostFD: z.number().gt(0).lt(1).optional(),
  fromPool: z.boolean().default(true),
}).refine(a => (a.shares === undefined) !== (a.percentOfPostFD === undefined), {
  message: "Advisor needs exactly one of `shares` or `percentOfPostFD`",
});
export const FeesSchema = z.object({
  placementCashPercent: z.number().min(0).lt(1).default(0).describe("cash fee as fraction of new money, e.g. 0.05"),
  placementEquityPercent: z.number().min(0).lt(1).default(0).describe("fee paid in shares at round price, as fraction of new money"),
  placementAgentName: z.string().default("Placement agent"),
  fixedCashFees: z.number().min(0).default(0).describe("legal/other cash costs"),
}).default({});
export const RoundSchema = z.object({
  roundName: z.string().default("Series A"),
  preMoneyValuation: z.number().positive().optional(),
  pricePerShare: z.number().positive().optional(),
  newInvestors: z.array(InvestorSchema).default([]),
  targetPoolPercent: z.number().min(0).lt(1).optional().describe("unallocated pool target as fraction of post-money FD"),
  poolTiming: z.enum(["pre-money", "post-money"]).default("pre-money"),
  promisedOptions: z.number().nonnegative().optional().describe("number of options promised to employees; per YC post-money SAFE, only max(0, promisedOptions - existingPool) of any pool increase is included in Company Capitalization"),
  fees: FeesSchema,
  pricePrecision: z.number().int().min(0).max(10).default(6),
}).refine(r => (r.preMoneyValuation === undefined) !== (r.pricePerShare === undefined), {
  message: "Provide exactly one of `preMoneyValuation` or `pricePerShare`",
});
export const PricedRoundInput = z.object({
  capTable: z.array(HolderSchema).min(1, "capTable needs at least one holder"),
  safes: z.array(SafeSchema).default([]),
  notes: z.array(NoteSchema).default([]),
  round: RoundSchema,
  advisors: z.array(AdvisorSchema).default([]),
});
export type PricedRoundInputT = z.input<typeof PricedRoundInput>;

// Scenario token utilities (phase 2)
const SCENARIO_TOKEN_VERSION = "sct1.";
const MAX_TOKEN_SIZE = 100_000; // bytes

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function base64UrlDecode(str: string): Buffer {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64");
}

export function createScenarioToken(input: any, type: "priced_round" | "sequence" | "pool_timing"): string {
  // Create canonical JSON by sorting keys recursively
  const canonical = JSON.stringify(input, (key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce((sorted: any, k) => {
        sorted[k] = value[k];
        return sorted;
      }, {});
    }
    return value;
  });
  const compressed = deflateSync(canonical);
  if (compressed.length > MAX_TOKEN_SIZE) {
    throw new Error(`Scenario too large for token (${compressed.length} bytes, max ${MAX_TOKEN_SIZE})`);
  }
  return SCENARIO_TOKEN_VERSION + type + "." + base64UrlEncode(compressed);
}

export function decodeScenarioToken(token: string): { type: "priced_round" | "sequence" | "pool_timing"; input: any } {
  if (!token.startsWith(SCENARIO_TOKEN_VERSION)) {
    throw new Error(`Unknown scenario token version. Expected ${SCENARIO_TOKEN_VERSION}*, got ${token.slice(0, 20)}...`);
  }
  const rest = token.slice(SCENARIO_TOKEN_VERSION.length);
  const dotIdx = rest.indexOf(".");
  if (dotIdx === -1) throw new Error("Malformed scenario token: missing type separator");
  
  const type = rest.slice(0, dotIdx) as "priced_round" | "sequence" | "pool_timing";
  const encoded = rest.slice(dotIdx + 1);
  
  if (!["priced_round", "sequence", "pool_timing"].includes(type)) {
    throw new Error(`Unknown scenario type: ${type}`);
  }
  
  try {
    const compressed = base64UrlDecode(encoded);
    const json = inflateSync(compressed).toString("utf-8");
    const input = JSON.parse(json);
    return { type, input };
  } catch (e) {
    throw new Error(`Corrupt scenario token: ${(e as Error).message}`);
  }
}

export interface Row { name: string; class: string; before: number; after: number; pctBefore: number; pctAfter: number; dilutionPct: number; }
export interface ConversionDetail { name: string; kind: "safe" | "note"; amountConverting: number; capPrice: number | null; discountPrice: number | null; conversionPrice: number; method: string; shares: number; effectiveCap?: number; effectiveDiscount?: number; }

const POOL = "Unallocated option pool";

function poolKey(h: { class: string }) { return h.class === "pool"; }

/**
 * MFN rule (YC MFN SAFE): the holder may adopt the FULL terms of ONE later SAFE, never mix terms.
 * "Most favourable" = lowest valuation cap (uncapped counts as infinite); ties broken by highest discount.
 * Later terms are adopted only if strictly more favourable than the MFN SAFE's own terms.
 */
export function resolveMfn(safes: z.infer<typeof SafeSchema>[]) {
  const key = (c?: number, d?: number) => [c ?? Infinity, -(d ?? 0)] as const;
  const better = (a: readonly [number, number], b: readonly [number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  return safes.map((s, i) => {
    if (!s.mfn) return { ...s };
    let best = key(s.valuationCap, s.discount); let pick: (typeof safes)[number] | undefined;
    for (const later of safes.slice(i + 1)) { const k = key(later.valuationCap, later.discount); if (better(k, best)) { best = k; pick = later; } }
    return pick ? { ...s, valuationCap: pick.valuationCap, discount: pick.discount, type: pick.type, mfnAdoptedFrom: pick.name } : { ...s };
  });
}

export function noteAmount(n: z.infer<typeof NoteSchema>) {
  return n.principal * (1 + n.annualInterestRate * n.daysOutstanding / 365);
}

export function modelPricedRound(raw: PricedRoundInputT) {
  const input = PricedRoundInput.parse(raw);
  const { round } = input;
  const warnings: string[] = [];
  const holders = input.capTable.map(h => ({ ...h }));
  const E = holders.reduce((a, h) => a + h.shares, 0);
  if (E <= 0) throw new Error("capTable must contain a positive number of shares");
  const existingPool = holders.filter(poolKey).reduce((a, h) => a + h.shares, 0);
  const safes = resolveMfn(input.safes);
  const convs = [
    ...safes.map(s => ({ name: s.name, kind: "safe" as const, amount: s.amount, cap: s.valuationCap, discount: s.discount, post: s.type === "post-money" })),
    ...input.notes.map(n => ({ name: n.name, kind: "note" as const, amount: noteAmount(n), cap: n.valuationCap, discount: n.discount, post: n.capType === "post-money" })),
  ];
  const newMoney = round.newInvestors.reduce((a, i) => a + i.amount, 0);
  const eqFeeMoney = newMoney * round.fees.placementEquityPercent;
  const target = round.targetPoolPercent;
  const prePool = round.poolTiming === "pre-money";

  let T = 0; let S = convs.map(() => 0); let P = round.pricePerShare ?? round.preMoneyValuation! / E;
  let detail: ConversionDetail[] = [];
  for (let iter = 0; iter < 10000; iter++) {
    const sumS = S.reduce((a, b) => a + b, 0);
    const pricedT = prePool ? T : 0;
    // Per YC post-money SAFE: pool increase is only included in Company Capitalization
    // "to the extent that the number of Promised Options exceeds the Unissued Option Pool prior to such increase"
    const promisedOptions = round.promisedOptions ?? 0;
    const poolForPostMoneyCap = prePool ? Math.max(0, Math.min(promisedOptions - existingPool, T)) : 0;
    const newP = round.pricePerShare ?? round.preMoneyValuation! / (E + pricedT + sumS);
    detail = convs.map(c => {
      const capPrice = c.cap === undefined ? null : c.post ? c.cap / (E + poolForPostMoneyCap + sumS) : c.cap / E;
      const discountPrice = c.discount === undefined ? null : newP * (1 - c.discount);
      const cands: [number, string][] = [[newP, "round price"]];
      if (capPrice !== null) cands.push([capPrice, "valuation cap"]);
      if (discountPrice !== null) cands.push([discountPrice, "discount"]);
      cands.sort((a, b) => a[0] - b[0]);
      const [price, method] = cands[0];
      return { name: c.name, kind: c.kind, amountConverting: c.amount, capPrice, discountPrice, conversionPrice: price, method, shares: c.amount / price, effectiveCap: c.cap, effectiveDiscount: c.discount };
    });
    const newS = detail.map(d => d.shares);
    const sumNewS = newS.reduce((a, b) => a + b, 0);
    const N = (newMoney + eqFeeMoney) / newP;
    let newT = 0;
    if (target !== undefined) {
      // pool after = existingPool + T = target * (E + T + S + N)
      newT = Math.max(0, (target * (E + sumNewS + N) - existingPool) / (1 - target));
    }
    const delta = Math.abs(newP - P) + Math.abs(newT - T) + newS.reduce((a, s, i) => a + Math.abs(s - S[i]), 0);
    P = newP; T = newT; S = newS;
    if (delta < 1e-9 && iter > 0) break;
    if (iter === 9999) warnings.push("Solver did not fully converge; results approximate.");
  }
  if (target !== undefined && T === 0) warnings.push(`Existing pool already meets ${(target * 100).toFixed(2)}% target; no top-up.`);

  const after: { name: string; class: string; before: number; after: number }[] = holders.map(h => ({ name: h.name, class: h.class, before: h.shares, after: h.shares }));
  const addRow = (name: string, cls: string, shares: number) => {
    const ex = after.find(r => r.name === name && r.class === cls);
    if (ex) ex.after += Math.floor(shares); else after.push({ name, class: cls, before: 0, after: Math.floor(shares) });
  };
  const pricedRoundPrice = P;
  detail.forEach(d => { d.shares = Math.floor(d.shares); addRow(d.name, "preferred", d.shares); });
  round.newInvestors.forEach(i => addRow(i.name, "preferred", i.amount / P));
  if (eqFeeMoney > 0) addRow(round.fees.placementAgentName, "preferred (fee)", eqFeeMoney / P);
  if (T > 0) {
    const pool = after.find(r => r.class === "pool");
    if (pool) pool.after += Math.floor(T); else addRow(POOL, "pool", T);
  }
  // advisors (post-close)
  for (const a of input.advisors) {
    const total = after.reduce((s, r) => s + r.after, 0);
    let sh: number;
    if (a.shares !== undefined) sh = a.shares;
    else sh = a.fromPool ? a.percentOfPostFD! * total : (a.percentOfPostFD! * total) / (1 - a.percentOfPostFD!);
    sh = Math.floor(sh);
    if (a.fromPool) {
      const pool = after.find(r => r.class === "pool");
      if (!pool || pool.after < sh) throw new Error(`Advisor ${a.name}: needs ${sh} shares but unallocated pool has ${pool?.after ?? 0}. Increase targetPoolPercent or set fromPool=false.`);
      pool.after -= sh;
      addRow(a.name, "options", sh);
    } else addRow(a.name, "common (advisor)", sh);
  }
  const totBefore = after.reduce((s, r) => s + r.before, 0);
  const totAfter = after.reduce((s, r) => s + r.after, 0);
  const rows: Row[] = after.map(r => ({
    ...r,
    pctBefore: r.before / totBefore,
    pctAfter: r.after / totAfter,
    dilutionPct: r.before > 0 ? 1 - (r.after / totAfter) / (r.before / totBefore) : 0,
  }));
  const placementCash = newMoney * round.fees.placementCashPercent + round.fees.fixedCashFees;
  const prec = round.pricePrecision;
  const summary = {
    roundName: round.roundName,
    pricePerShare: Number(pricedRoundPrice.toFixed(prec)),
    pricePerShareExact: pricedRoundPrice,
    preMoneyValuation: round.preMoneyValuation ?? pricedRoundPrice * (E + (prePool ? T : 0) + S.reduce((a, b) => a + b, 0)),
    newMoney,
    postMoneyValuation: pricedRoundPrice * totAfter,
    sharesBefore: totBefore,
    sharesAfter: totAfter,
    poolTopUpShares: Math.floor(T),
    poolTiming: round.poolTiming,
    fees: { placementCash, placementEquityShares: eqFeeMoney > 0 ? Math.floor(eqFeeMoney / P) : 0, netProceeds: newMoney - placementCash },
  };
  const scenarioToken = createScenarioToken(raw, "priced_round");
  return { summary, conversions: detail, capTable: rows, warnings, scenarioToken, markdown: renderMarkdown(summary, detail, rows, warnings) };
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const pct = (n: number) => (n * 100).toFixed(2) + "%";
const money = (n: number) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 });

export function renderMarkdown(s: any, conv: ConversionDetail[], rows: Row[], warnings: string[]) {
  let md = `## ${s.roundName}: ${money(s.newMoney)} at ${money(s.preMoneyValuation)} pre-money\n\n`;
  md += `Price per share: **$${s.pricePerShare}**  |  Post-money: **${money(s.postMoneyValuation)}**  |  FD shares: ${fmt(s.sharesBefore)} → ${fmt(s.sharesAfter)}`;
  if (s.poolTopUpShares) md += `  |  Pool top-up (${s.poolTiming}): ${fmt(s.poolTopUpShares)}`;
  md += "\n\n";
  if (conv.length) {
    md += `### Conversions\n\n| Instrument | Converting | Cap price | Discount price | Conversion price | Method | Shares |\n|---|---:|---:|---:|---:|---|---:|\n`;
    for (const c of conv) md += `| ${c.name} (${c.kind}) | ${money(c.amountConverting)} | ${c.capPrice === null ? "-" : "$" + c.capPrice.toFixed(4)} | ${c.discountPrice === null ? "-" : "$" + c.discountPrice.toFixed(4)} | $${c.conversionPrice.toFixed(4)} | ${c.method} | ${fmt(c.shares)} |\n`;
    md += "\n";
  }
  md += `### Cap table\n\n| Holder | Class | Shares before | % before | Shares after | % after (FD) | Dilution |\n|---|---|---:|---:|---:|---:|---:|\n`;
  for (const r of rows) md += `| ${r.name} | ${r.class} | ${fmt(r.before)} | ${pct(r.pctBefore)} | ${fmt(r.after)} | ${pct(r.pctAfter)} | ${r.before ? pct(r.dilutionPct) : "new"} |\n`;
  md += `| **Total** | | **${fmt(s.sharesBefore)}** | 100.00% | **${fmt(s.sharesAfter)}** | 100.00% | |\n`;
  if (s.fees.placementCash || s.fees.placementEquityShares) md += `\nFees: cash ${money(s.fees.placementCash)}, equity ${fmt(s.fees.placementEquityShares)} shares. Net proceeds ${money(s.fees.netProceeds)}.\n`;
  if (warnings.length) md += `\n> ${warnings.join("\n> ")}\n`;
  return md;
}

/** Post-money SAFE ownership snapshot (before any priced round). */
export const SafeOwnershipInput = z.object({
  safes: z.array(SafeSchema).min(1),
  preSafeShares: z.number().positive().optional().describe("FD shares before SAFEs; enables share estimates"),
});
export function safeOwnership(raw: z.input<typeof SafeOwnershipInput>) {
  const { safes, preSafeShares } = SafeOwnershipInput.parse(raw);
  const res = resolveMfn(safes);
  const rows = res.map(s => {
    if (s.type !== "post-money") return { name: s.name, amount: s.amount, valuationCap: s.valuationCap ?? null, ownership: null as number | null, note: "Pre-money SAFE ownership depends on other SAFEs and the round; use model_priced_round." };
    if (s.valuationCap === undefined) return { name: s.name, amount: s.amount, valuationCap: null, ownership: null, note: "Uncapped: ownership set by the round price (and discount)." };
    return { name: s.name, amount: s.amount, valuationCap: s.valuationCap, ownership: s.amount / s.valuationCap, note: "amount / post-money cap" };
  });
  const totalSafe = rows.reduce((a, r) => a + (r.ownership ?? 0), 0);
  if (totalSafe >= 1) throw new Error("Capped post-money SAFEs sum to >= 100% ownership; check amounts and caps.");
  let shares: { name: string; shares: number }[] | undefined;
  if (preSafeShares) {
    const total = preSafeShares / (1 - totalSafe);
    shares = rows.filter(r => r.ownership !== null).map(r => ({ name: r.name, shares: Math.floor(r.ownership! * total) }));
  }
  let md = `| SAFE | Amount | Post-money cap | Implied ownership |\n|---|---:|---:|---:|\n`;
  for (const r of rows) md += `| ${r.name} | ${money(r.amount)} | ${r.valuationCap ? money(r.valuationCap) : "-"} | ${r.ownership !== null ? pct(r.ownership) : r.note} |\n`;
  md += `\nCombined capped post-money SAFE ownership: **${pct(totalSafe)}**; existing holders keep ${pct(1 - totalSafe)} (before round, pool top-up, and new money).\n`;
  return { safes: rows, combinedSafeOwnership: totalSafe, existingHoldersOwnership: 1 - totalSafe, estimatedShares: shares, markdown: md };
}

/** Single-instrument conversion price explainer. */
export const ConversionInput = z.object({
  amount: z.number().positive(),
  roundPricePerShare: z.number().positive(),
  valuationCap: z.number().positive().optional(),
  discount: z.number().min(0).lt(1).optional(),
  capitalizationShares: z.number().positive().optional().describe("Shares the cap is divided by (post-money SAFE: company capitalization incl. conversions; pre-money: pre-round FD)"),
});
export function safeConversion(raw: z.input<typeof ConversionInput>) {
  const i = ConversionInput.parse(raw);
  if (i.valuationCap !== undefined && i.capitalizationShares === undefined) throw new Error("capitalizationShares is required when valuationCap is set");
  const capPrice = i.valuationCap !== undefined ? i.valuationCap / i.capitalizationShares! : null;
  const discountPrice = i.discount !== undefined ? i.roundPricePerShare * (1 - i.discount) : null;
  const opts = [{ p: i.roundPricePerShare, m: "round price" }, ...(capPrice ? [{ p: capPrice, m: "valuation cap" }] : []), ...(discountPrice ? [{ p: discountPrice, m: "discount" }] : [])].sort((a, b) => a.p - b.p);
  const shares = Math.floor(i.amount / opts[0].p);
  return { capPrice, discountPrice, conversionPrice: opts[0].p, method: opts[0].m, shares, effectiveDiscountToRound: 1 - opts[0].p / i.roundPricePerShare,
    markdown: `Converts at **$${opts[0].p.toFixed(4)}** via ${opts[0].m} → **${shares.toLocaleString("en-US")} shares** (cap price ${capPrice ? "$" + capPrice.toFixed(4) : "n/a"}, discount price ${discountPrice ? "$" + discountPrice.toFixed(4) : "n/a"}, round $${i.roundPricePerShare}).` };
}

/** Sequence of events: priced rounds (with conversions) and tranche closes at fixed prices/valuations. */
const TrancheEvent = z.object({
  type: z.literal("tranche"),
  name: z.string().default("Tranche"),
  investors: z.array(InvestorSchema).min(1),
  pricePerShare: z.number().positive().optional(),
  preMoneyValuation: z.number().positive().optional(),
}).refine(t => (t.pricePerShare === undefined) !== (t.preMoneyValuation === undefined), { message: "Tranche needs exactly one of pricePerShare or preMoneyValuation" });
const SafeEvent = z.object({ type: z.literal("safe"), safe: SafeSchema });
const NoteEvent = z.object({ type: z.literal("note"), note: NoteSchema });
const RoundEvent = z.object({ type: z.literal("priced_round"), round: RoundSchema, advisors: z.array(AdvisorSchema).default([]) });
export const SequenceInput = z.object({
  capTable: z.array(HolderSchema).min(1),
  events: z.array(z.union([TrancheEvent, SafeEvent, NoteEvent, RoundEvent])).min(1),
});
export function modelSequence(raw: z.input<typeof SequenceInput>) {
  const input = SequenceInput.parse(raw);
  let table = input.capTable.map(h => ({ ...h }));
  const start = table.map(h => ({ ...h }));
  let pendingSafes: any[] = []; let pendingNotes: any[] = [];
  const steps: any[] = [];
  for (const ev of input.events) {
    if (ev.type === "safe") { pendingSafes.push(ev.safe); steps.push({ event: `SAFE issued: ${ev.safe.name}`, markdown: `SAFE ${ev.safe.name}: $${ev.safe.amount.toLocaleString()} ${ev.safe.type}${ev.safe.valuationCap ? " cap $" + ev.safe.valuationCap.toLocaleString() : ""}${ev.safe.discount ? `, ${ev.safe.discount * 100}% discount` : ""}` }); continue; }
    if (ev.type === "note") { pendingNotes.push(ev.note); steps.push({ event: `Note issued: ${ev.note.name}`, markdown: `Note ${ev.note.name}: $${ev.note.principal.toLocaleString()}` }); continue; }
    if (ev.type === "priced_round") {
      const r = modelPricedRound({ capTable: table, safes: pendingSafes, notes: pendingNotes, round: ev.round, advisors: ev.advisors });
      pendingSafes = []; pendingNotes = [];
      table = r.capTable.filter(x => x.after > 0 || x.class === "pool").map(x => ({ name: x.name, shares: x.after, class: x.class }));
      steps.push({ event: ev.round.roundName ?? "Priced round", summary: r.summary, markdown: r.markdown });
      continue;
    }
    // tranche
    const total = table.reduce((a, h) => a + h.shares, 0);
    const price = ev.pricePerShare ?? ev.preMoneyValuation! / total;
    for (const inv of ev.investors) {
      const sh = Math.floor(inv.amount / price);
      const ex = table.find(h => h.name === inv.name && h.class === "preferred");
      if (ex) ex.shares += sh; else table.push({ name: inv.name, shares: sh, class: "preferred" });
    }
    steps.push({ event: ev.name, pricePerShare: price, markdown: `### ${ev.name}\nIssued at $${price.toFixed(6)}/share (${ev.preMoneyValuation ? "pre-money $" + ev.preMoneyValuation.toLocaleString() : "fixed price"}).` });
  }
  const totS = start.reduce((a, h) => a + h.shares, 0), totE = table.reduce((a, h) => a + h.shares, 0);
  const names = [...new Set([...start, ...table].map(h => h.name + "|" + h.class))];
  const rows = names.map(k => { const [name, cls] = k.split("|"); const b = start.find(h => h.name === name && h.class === cls)?.shares ?? 0; const a = table.find(h => h.name === name && h.class === cls)?.shares ?? 0; return { name, class: cls, before: b, after: a, pctBefore: b / totS, pctAfter: a / totE, dilutionPct: b ? 1 - (a / totE) / (b / totS) : 0 }; });
  const unconverted = [...pendingSafes.map(s => s.name), ...pendingNotes.map(n => n.name)];
  let md = steps.map(s => s.markdown).join("\n\n") + `\n\n## Final cap table\n\n| Holder | Class | Start | % start | Final | % final | Dilution |\n|---|---|---:|---:|---:|---:|---:|\n`;
  for (const r of rows) md += `| ${r.name} | ${r.class} | ${fmt(r.before)} | ${pct(r.pctBefore)} | ${fmt(r.after)} | ${pct(r.pctAfter)} | ${r.before ? pct(r.dilutionPct) : "new"} |\n`;
  if (unconverted.length) md += `\n> Outstanding (unconverted) instruments: ${unconverted.join(", ")}\n`;
  const scenarioToken = createScenarioToken(raw, "sequence");
  return { steps, capTable: rows, outstandingInstruments: unconverted, scenarioToken, markdown: md };
}

/** Run the same round with pre-money vs post-money pool to show who bears the top-up. */
export function comparePoolTiming(raw: PricedRoundInputT) {
  const base = PricedRoundInput.parse(raw);
  if (base.round.targetPoolPercent === undefined) throw new Error("round.targetPoolPercent is required for pool comparison");
  const pre = modelPricedRound({ ...raw, round: { ...(raw.round as any), poolTiming: "pre-money" } });
  const post = modelPricedRound({ ...raw, round: { ...(raw.round as any), poolTiming: "post-money" } });
  const rows = pre.capTable.map(r => ({ name: r.name, class: r.class, pctPrePool: r.pctAfter, pctPostPool: post.capTable.find(x => x.name === r.name && x.class === r.class)?.pctAfter ?? 0 }));
  let md = `## Option pool shuffle: pre-money vs post-money top-up to ${pct(base.round.targetPoolPercent)}\n\nPrice/share: pre-money pool **$${pre.summary.pricePerShare}** vs post-money pool **$${post.summary.pricePerShare}**. Effective pre-money for existing holders (excl. pool top-up): ${money(pre.summary.pricePerShareExact * (pre.summary.sharesBefore + pre.conversions.reduce((a, c) => a + c.shares, 0)))} vs ${money(post.summary.preMoneyValuation)}.\n\nA **pre-money pool** top-up dilutes founders and post-money SAFE holders (not new investors). A **post-money pool** dilutes everyone including new investors.\n\n| Holder | Class | % after (pool in pre-money) | % after (pool in post-money) | Difference |\n|---|---|---:|---:|---:|\n`;
  for (const r of rows) md += `| ${r.name} | ${r.class} | ${pct(r.pctPrePool)} | ${pct(r.pctPostPool)} | ${((r.pctPrePool - r.pctPostPool) * 100).toFixed(2)} pp |\n`;
  const scenarioToken = createScenarioToken(raw, "pool_timing");
  return { preMoneyPool: pre.summary, postMoneyPool: post.summary, rows, scenarioToken, markdown: md };
}

/** Load and rerun a scenario from a scenario token. */
export const LoadScenarioInput = z.object({
  scenarioToken: z.string().min(1),
});
export function loadScenario(raw: z.input<typeof LoadScenarioInput>) {
  const { scenarioToken } = LoadScenarioInput.parse(raw);
  const { type, input } = decodeScenarioToken(scenarioToken);
  
  switch (type) {
    case "priced_round":
      return modelPricedRound(input);
    case "sequence":
      return modelSequence(input);
    case "pool_timing":
      return comparePoolTiming(input);
    default:
      throw new Error(`Unknown scenario type: ${type}`);
  }
}

/** Compare multiple scenarios side-by-side. */
export const ScenarioInput = z.union([
  z.object({ type: z.literal("priced_round"), input: z.any() }),
  z.object({ type: z.literal("sequence"), input: z.any() }),
  z.object({ type: z.literal("pool_timing"), input: z.any() }),
  z.object({ type: z.literal("token"), scenarioToken: z.string() }),
]);
export const CompareScenariosInput = z.object({
  scenarios: z.array(z.object({
    name: z.string().min(1),
    scenario: ScenarioInput,
  })).min(2).max(6),
  baselineName: z.string().optional(),
});
export function compareScenarios(raw: z.input<typeof CompareScenariosInput>) {
  const input = CompareScenariosInput.parse(raw);
  
  // Run each scenario
  const results: { name: string; result: any }[] = [];
  for (const s of input.scenarios) {
    let result: any;
    if (s.scenario.type === "token") {
      result = loadScenario({ scenarioToken: s.scenario.scenarioToken });
    } else if (s.scenario.type === "priced_round") {
      result = modelPricedRound(s.scenario.input);
    } else if (s.scenario.type === "sequence") {
      result = modelSequence(s.scenario.input);
    } else {
      result = comparePoolTiming(s.scenario.input);
    }
    results.push({ name: s.name, result });
  }
  
  // Extract cap tables and find all unique holders
  const capTables = results.map(r => {
    // For sequence results, use capTable; for priced_round, use capTable; for pool_timing, extract from rows
    if (r.result.capTable) return r.result.capTable;
    if (r.result.rows) {
      // pool_timing format: convert to standard cap table format
      return r.result.rows.map((row: any) => ({ name: row.name, class: row.class, pctAfter: row.pctPrePool }));
    }
    throw new Error(`Unexpected result format for scenario ${r.name}`);
  });
  
  // Collect all unique holder names across all scenarios
  const allHolders = new Set<string>();
  capTables.forEach(ct => {
    ct.forEach((h: any) => {
      const key = h.name;
      allHolders.add(key);
    });
  });
  
  // Build comparison table
  const baselineIdx = input.baselineName 
    ? results.findIndex(r => r.name === input.baselineName)
    : 0;
  if (baselineIdx === -1) throw new Error(`Baseline scenario "${input.baselineName}" not found`);
  
  const comparisonRows: any[] = [];
  for (const holderName of allHolders) {
    const row: any = { holder: holderName };
    
    for (let i = 0; i < results.length; i++) {
      const ct = capTables[i];
      const holder = ct.find((h: any) => h.name === holderName);
      const pct = holder?.pctAfter ?? 0;
      row[results[i].name] = pct;
      
      // Calculate delta vs baseline
      if (i !== baselineIdx) {
        const baseHolder = capTables[baselineIdx].find((h: any) => h.name === holderName);
        const basePct = baseHolder?.pctAfter ?? 0;
        row[`${results[i].name}_delta`] = pct - basePct;
      }
    }
    
    comparisonRows.push(row);
  }
  
  // Extract summary data (price per share, post-money, dilution)
  const summaries = results.map(r => {
    const res = r.result;
    // For priced_round and sequence with steps that have summaries
    if (res.summary) {
      return {
        name: r.name,
        pricePerShare: res.summary.pricePerShare,
        postMoneyValuation: res.summary.postMoneyValuation,
      };
    }
    // For pool_timing
    if (res.preMoneyPool) {
      return {
        name: r.name,
        pricePerShare: res.preMoneyPool.pricePerShare,
        postMoneyValuation: res.preMoneyPool.postMoneyValuation,
      };
    }
    // For sequence, use the last step's summary if available
    if (res.steps && res.steps.length > 0) {
      const lastStep = res.steps[res.steps.length - 1];
      if (lastStep.summary) {
        return {
          name: r.name,
          pricePerShare: lastStep.summary.pricePerShare,
          postMoneyValuation: lastStep.summary.postMoneyValuation,
        };
      }
    }
    return { name: r.name, pricePerShare: null, postMoneyValuation: null };
  });
  
  // Find biggest differences
  const baselineName = results[baselineIdx].name;
  const differences: string[] = [];
  comparisonRows.forEach(row => {
    const baselinePct = row[baselineName] ?? 0;
    for (let i = 0; i < results.length; i++) {
      if (i === baselineIdx) continue;
      const name = results[i].name;
      const pct = row[name] ?? 0;
      const delta = pct - baselinePct;
      if (Math.abs(delta) >= 0.01) { // >= 1 pp difference
        differences.push(`${row.holder}: ${name} vs ${baselineName} = ${(delta * 100).toFixed(2)} pp`);
      }
    }
  });
  
  // Sort differences by magnitude
  differences.sort((a, b) => {
    const aMatch = a.match(/([-\d.]+) pp/);
    const bMatch = b.match(/([-\d.]+) pp/);
    const aMag = aMatch ? Math.abs(parseFloat(aMatch[1])) : 0;
    const bMag = bMatch ? Math.abs(parseFloat(bMatch[1])) : 0;
    return bMag - aMag;
  });
  
  // Generate markdown table
  let md = `## Scenario comparison\n\nBaseline: **${baselineName}**\n\n`;
  md += `### Ownership comparison\n\n`;
  md += `| Holder | ${results.map(r => r.name).join(" | ")} | ${results.filter((_, i) => i !== baselineIdx).map(r => `Δ vs ${baselineName}`).join(" | ")} |\n`;
  md += `|---|${results.map(() => "---:").join("|")}|${results.filter((_, i) => i !== baselineIdx).map(() => "---:").join("|")}|\n`;
  
  for (const row of comparisonRows) {
    md += `| ${row.holder} |`;
    for (const r of results) {
      md += ` ${pct(row[r.name] ?? 0)} |`;
    }
    for (let i = 0; i < results.length; i++) {
      if (i !== baselineIdx) {
        const delta = row[`${results[i].name}_delta`] ?? 0;
        md += ` ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(2)} pp |`;
      }
    }
    md += "\n";
  }
  
  md += `\n### Round summary\n\n`;
  md += `| Scenario | Price/share | Post-money valuation |\n|---|---:|---:|\n`;
  for (const s of summaries) {
    const price = s.pricePerShare !== null ? `$${s.pricePerShare}` : "n/a";
    const postMoney = s.postMoneyValuation !== null ? money(s.postMoneyValuation) : "n/a";
    md += `| ${s.name} | ${price} | ${postMoney} |\n`;
  }
  
  md += `\n### Key differences\n\n`;
  if (differences.length === 0) {
    md += `No significant ownership differences (< 1 pp) between scenarios.\n`;
  } else {
    const top5 = differences.slice(0, 5);
    for (const diff of top5) {
      md += `- ${diff}\n`;
    }
    if (differences.length > 5) {
      md += `\n... and ${differences.length - 5} more differences.\n`;
    }
  }
  
  return { comparison: comparisonRows, summaries, keyDifferences: differences.slice(0, 10), markdown: md };
}

export const METHODOLOGY = `# Methodology

- Fully diluted (FD) = issued shares + granted options + unallocated pool.
- Post-money SAFE (YC): cap price = cap / Company Capitalization, where Company Capitalization = pre-round FD + all conversion shares + any pre-money pool increase, but only to the extent promisedOptions exceeds the existing pool (per YC SAFE). New-money shares excluded. Ownership at conversion ~= amount / cap.
- Pre-money SAFE and notes (default): cap price = cap / pre-round FD (excludes all converting securities and pool increase).
- Notes convert principal + simple interest (rate x days/365).
- Discount price = round price x (1 - discount). Holder gets the LOWEST of round, cap and discount prices.
- MFN SAFE: adopts lowest cap and highest discount among SAFEs listed after it.
- Pre-money pool: pool top-up counted in pre-money price (dilutes existing holders, pre-money instruments, and post-money SAFEs, but not new investors).
- Post-money pool: top-up issued after pricing; dilutes everyone, including new investors.
- Target pool % = unallocated pool / post-round FD (before advisor grants).
- Equity placement fee: shares at round price worth (fee% x new money), priced like new-money shares.
- Advisor grants: issued after close; fromPool=true reduces unallocated pool, otherwise new shares (percent sized so advisor holds that % of final FD).
- Circular round math solved by deterministic fixed-point iteration; shares rounded down per holder; price unrounded internally.
- This is a modelling tool, not legal, tax or investment advice. Confirm with counsel and your actual instruments.
- **Scenario tokens** (v1.1+): modeling tools return a scenarioToken — a versioned, compressed, base64url-encoded snapshot of the validated input. Load it with load_scenario to rerun the exact same scenario later, or pass it to compare_scenarios to compare multiple scenarios side-by-side. Tokens are portable, deterministic, and self-contained.
`;

/** Pro-rata right (YC pro rata side letter): buy enough of the new round to keep current FD ownership. */
export function proRata(i: { currentOwnership: number; roundSize: number; postMoneyValuation?: number }) {
  if (i.currentOwnership < 0 || i.currentOwnership >= 1) throw new Error("currentOwnership must be in [0,1)");
  const amount = i.currentOwnership * i.roundSize;
  return { amount, ownershipIfExercised: i.currentOwnership, markdown: `Pro-rata allocation: **${money(amount)}** of a ${money(i.roundSize)} round keeps ${pct(i.currentOwnership)}.` };
}

/** Placement/advisor fee schedule: tiered (marginal) success fee, retainer credit, warrant coverage. */
export const FeeScheduleInput = z.object({
  amountRaised: z.number().nonnegative(),
  tiers: z.array(z.object({ upTo: z.number().positive().nullable(), rate: z.number().min(0).lt(1) })).min(1).describe("marginal tiers, ascending; last upTo null = no limit"),
  monthlyRetainer: z.number().min(0).default(0), retainerMonths: z.number().int().min(0).default(0),
  retainerCreditable: z.boolean().default(true),
  minimumFee: z.number().min(0).default(0),
  warrantCoveragePercent: z.number().min(0).lt(1).default(0), warrantStrikePrice: z.number().positive().optional(),
});
export function feeSchedule(raw: z.input<typeof FeeScheduleInput>) {
  const i = FeeScheduleInput.parse(raw);
  let prev = 0, success = 0; const breakdown: { band: string; amount: number; fee: number }[] = [];
  for (const t of i.tiers) {
    const top = t.upTo ?? Infinity; if (top <= prev) throw new Error("tiers must be ascending");
    const band = Math.max(0, Math.min(i.amountRaised, top) - prev);
    if (band > 0) { success += band * t.rate; breakdown.push({ band: `${money(prev)}-${top === Infinity ? "+" : money(top)}`, amount: band, fee: band * t.rate }); }
    prev = top; if (i.amountRaised <= top) break;
  }
  const retainer = i.monthlyRetainer * i.retainerMonths;
  const successDue = Math.max(i.minimumFee, success) - (i.retainerCreditable ? Math.min(retainer, Math.max(i.minimumFee, success)) : 0);
  const totalCash = retainer + successDue;
  const warrantValue = i.amountRaised * i.warrantCoveragePercent;
  const warrantShares = i.warrantStrikePrice ? Math.floor(warrantValue / i.warrantStrikePrice) : null;
  return { successFee: success, retainer, successFeeDueAtClose: successDue, totalCashFees: totalCash, effectiveRate: i.amountRaised ? totalCash / i.amountRaised : 0, warrantCoverageValue: warrantValue, warrantShares, breakdown,
    markdown: `Success fee ${money(success)} (tiered), retainer ${money(retainer)}${i.retainerCreditable ? " credited" : ""}, due at close ${money(successDue)}. Total cash ${money(totalCash)} (${pct(i.amountRaised ? totalCash / i.amountRaised : 0)}). Warrants ${money(warrantValue)}${warrantShares !== null ? ` = ${fmt(warrantShares)} shares` : ""}.` };
}

/** Currency label + optional FX (rate = units of display currency per 1 model unit). */
export function formatMoney(amount: number, currency = "USD", fxRate = 1) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount * fxRate);
}
