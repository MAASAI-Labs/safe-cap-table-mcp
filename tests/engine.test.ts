import { describe, it, expect } from "vitest";
import * as E from "../src/engine";

const base = [
  { name: "Founders", shares: 9_000_000, class: "common" as const },
  { name: "Option pool", shares: 1_000_000, class: "pool" as const },
];
const row = (r: any, name: string) => r.capTable.find((x: any) => x.name === name)!;

describe("post-money SAFE (YC worked examples)", () => {
  it("$1M on $10M post-money cap = 10% ownership", () => {
    const r = E.safeOwnership({ safes: [{ name: "Seed SAFE", amount: 1_000_000, valuationCap: 10_000_000 }] });
    expect(r.combinedSafeOwnership).toBeCloseTo(0.1, 12);
  });
  it("two SAFEs stack additively: 10% + 10% = 20%, founders keep 80%", () => {
    const r = E.safeOwnership({ preSafeShares: 10_000_000, safes: [
      { name: "A", amount: 1_000_000, valuationCap: 10_000_000 },
      { name: "B", amount: 500_000, valuationCap: 5_000_000 }] });
    expect(r.combinedSafeOwnership).toBeCloseTo(0.2, 12);
    expect(r.estimatedShares).toEqual([{ name: "A", shares: 1_250_000 }, { name: "B", shares: 1_250_000 }]);
  });
  it("converts at Series A: $1M@$10M post, $10M at $40M pre", () => {
    const r = E.modelPricedRound({ capTable: base,
      safes: [{ name: "Seed SAFE", amount: 1_000_000, valuationCap: 10_000_000 }],
      round: { preMoneyValuation: 40_000_000, newInvestors: [{ name: "Series A Lead", amount: 10_000_000 }] } });
    // SAFE = 10% of capitalization (10M + S) -> S = 1,111,111; safe price $0.90; Series A price $3.60
    expect(r.conversions[0].shares).toBe(1_111_111);
    expect(r.conversions[0].conversionPrice).toBeCloseTo(0.9, 9);
    expect(r.summary.pricePerShareExact).toBeCloseTo(3.6, 9);
    expect(row(r, "Series A Lead").after).toBe(2_777_777);
    expect(row(r, "Seed SAFE").pctAfter).toBeCloseTo(0.08, 6);
    expect(row(r, "Founders").pctAfter).toBeCloseTo(0.648, 6);
  });
  it("post-money SAFE is NOT diluted by a pre-money pool top-up (holds 10% of pre-money capitalization)", () => {
    const r = E.modelPricedRound({ capTable: base,
      safes: [{ name: "Seed SAFE", amount: 1_000_000, valuationCap: 10_000_000 }],
      round: { preMoneyValuation: 40_000_000, newInvestors: [{ name: "A", amount: 10_000_000 }], targetPoolPercent: 0.15 } });
    const safe = row(r, "Seed SAFE").after, pool = r.capTable.find((x: any) => x.class === "pool")!.after;
    const preMoneyCap = 10_000_000 + safe + r.summary.poolTopUpShares;
    expect(safe / preMoneyCap).toBeCloseTo(0.1, 6);
    expect(pool / r.summary.sharesAfter).toBeCloseTo(0.15, 6);
  });
  it("cap vs discount best-of picks discount when round price is low", () => {
    const r = E.safeConversion({ amount: 100_000, roundPricePerShare: 1, valuationCap: 20_000_000, capitalizationShares: 10_000_000, discount: 0.2 });
    expect(r.method).toBe("discount"); expect(r.conversionPrice).toBeCloseTo(0.8); expect(r.shares).toBe(125_000);
  });
  it("uncapped discount-only SAFE converts at round x (1 - discount)", () => {
    const r = E.modelPricedRound({ capTable: [{ name: "F", shares: 10_000_000 }],
      safes: [{ name: "D", amount: 500_000, discount: 0.2 }],
      round: { pricePerShare: 1, newInvestors: [{ name: "A", amount: 1_000_000 }] } });
    expect(r.conversions[0].shares).toBe(625_000);
  });
  it("MFN SAFE adopts best later terms", () => {
    const r = E.safeOwnership({ safes: [{ name: "MFN", amount: 100_000, mfn: true }, { name: "Later", amount: 200_000, valuationCap: 8_000_000, discount: 0.15 }] });
    expect(r.safes[0].valuationCap).toBe(8_000_000);
    expect(r.safes[0].ownership).toBeCloseTo(0.0125);
  });
});

describe("pre-money SAFEs and notes", () => {
  it("pre-money SAFE cap price = cap / pre-round FD", () => {
    const r = E.modelPricedRound({ capTable: [{ name: "F", shares: 10_000_000 }],
      safes: [{ name: "Pre", type: "pre-money", amount: 800_000, valuationCap: 8_000_000 }],
      round: { preMoneyValuation: 20_000_000, newInvestors: [{ name: "A", amount: 5_000_000 }] } });
    expect(r.conversions[0].conversionPrice).toBeCloseTo(0.8, 9);
    expect(r.conversions[0].shares).toBe(1_000_000);
    // round price = 20M / (10M + 1M) = 1.818181...
    expect(r.summary.pricePerShareExact).toBeCloseTo(20_000_000 / 11_000_000, 9);
  });
  it("note converts principal + simple interest", () => {
    expect(E.noteAmount({ name: "N", principal: 100_000, annualInterestRate: 0.08, daysOutstanding: 365, capType: "pre-money" })).toBeCloseTo(108_000);
  });
});

describe("priced rounds (hand-checked)", () => {
  it("$2M on $8M pre, 10M shares -> $0.80, investor 20%", () => {
    const r = E.modelPricedRound({ capTable: [{ name: "F", shares: 8_000_000 }, { name: "Pool", shares: 2_000_000, class: "pool" }],
      round: { preMoneyValuation: 8_000_000, newInvestors: [{ name: "VC", amount: 2_000_000 }] } });
    expect(r.summary.pricePerShareExact).toBeCloseTo(0.8, 12);
    expect(row(r, "VC").after).toBe(2_500_000);
    expect(row(r, "VC").pctAfter).toBeCloseTo(0.2, 12);
    expect(r.summary.postMoneyValuation).toBeCloseTo(10_000_000, 3);
    expect(row(r, "F").dilutionPct).toBeCloseTo(0.2, 12);
  });
  it("pre-money pool shuffle to 10%: price falls to $0.70", () => {
    const r = E.modelPricedRound({ capTable: [{ name: "F", shares: 10_000_000 }],
      round: { preMoneyValuation: 8_000_000, newInvestors: [{ name: "VC", amount: 2_000_000 }], targetPoolPercent: 0.1 } });
    expect(r.summary.poolTopUpShares).toBe(1_428_571);
    expect(r.summary.pricePerShareExact).toBeCloseTo(0.7, 9);
    expect(row(r, "VC").pctAfter).toBeCloseTo(0.2, 6);
  });
  it("post-money pool: price stays $0.80 and investor is diluted to 18%", () => {
    const r = E.modelPricedRound({ capTable: [{ name: "F", shares: 10_000_000 }],
      round: { preMoneyValuation: 8_000_000, newInvestors: [{ name: "VC", amount: 2_000_000 }], targetPoolPercent: 0.1, poolTiming: "post-money" } });
    expect(r.summary.pricePerShareExact).toBeCloseTo(0.8, 12);
    expect(row(r, "VC").pctAfter).toBeCloseTo(0.18, 6);
  });
  it("comparePoolTiming shows founders bear the shuffle", () => {
    const r = E.comparePoolTiming({ capTable: [{ name: "F", shares: 10_000_000 }],
      round: { preMoneyValuation: 8_000_000, newInvestors: [{ name: "VC", amount: 2_000_000 }], targetPoolPercent: 0.1 } });
    const f = r.rows.find(x => x.name === "F")!;
    expect(f.pctPrePool).toBeCloseTo(0.7, 6); expect(f.pctPostPool).toBeCloseTo(0.72, 6);
  });
  it("placement fees: 5% cash and 2% equity", () => {
    const r = E.modelPricedRound({ capTable: [{ name: "F", shares: 10_000_000 }],
      round: { pricePerShare: 1, newInvestors: [{ name: "VC", amount: 2_000_000 }], fees: { placementCashPercent: 0.05, placementEquityPercent: 0.02, fixedCashFees: 25_000 } } });
    expect(r.summary.fees.placementCash).toBe(125_000);
    expect(r.summary.fees.netProceeds).toBe(1_875_000);
    expect(r.summary.fees.placementEquityShares).toBe(40_000);
  });
  it("advisor grants from pool and as new shares", () => {
    const r = E.modelPricedRound({ capTable: [{ name: "F", shares: 9_000_000 }, { name: "Pool", shares: 1_000_000, class: "pool" }],
      round: { pricePerShare: 1, newInvestors: [] },
      advisors: [{ name: "Adv1", shares: 100_000 }, { name: "Adv2", percentOfPostFD: 0.01, fromPool: false }] });
    expect(row(r, "Pool").after).toBe(900_000);
    expect(row(r, "Adv2").pctAfter).toBeCloseTo(0.01, 6);
  });
  it("advisor from an insufficient pool errors clearly", () => {
    expect(() => E.modelPricedRound({ capTable: [{ name: "F", shares: 1000 }], round: { pricePerShare: 1 }, advisors: [{ name: "A", shares: 10 }] })).toThrow(/unallocated pool/);
  });
});

describe("sequences (extension SAFEs at different caps, tranches)", () => {
  it("SAFE, extension SAFE at higher cap, Series A, then milestone tranche", () => {
    const r = E.modelSequence({ capTable: base, events: [
      { type: "safe", safe: { name: "Seed", amount: 1_000_000, valuationCap: 10_000_000 } },
      { type: "safe", safe: { name: "Seed extension", amount: 1_000_000, valuationCap: 20_000_000 } },
      { type: "priced_round", round: { preMoneyValuation: 40_000_000, newInvestors: [{ name: "Lead", amount: 8_000_000 }] } },
      { type: "tranche", name: "Tranche 2", investors: [{ name: "Lead", amount: 2_000_000 }], pricePerShare: 5 },
    ] });
    const seed = r.capTable.find(x => x.name === "Seed")!, ext = r.capTable.find(x => x.name === "Seed extension")!;
    expect(seed.after / ext.after).toBeCloseTo(2, 5);
    expect(r.outstandingInstruments).toEqual([]);
    expect(r.steps).toHaveLength(4);
  });
});

describe("validation", () => {
  it("rejects both preMoney and price", () => {
    expect(() => E.modelPricedRound({ capTable: base, round: { preMoneyValuation: 1, pricePerShare: 1 } })).toThrow(/exactly one/);
  });
  it("rejects negative amounts and discount >= 1", () => {
    expect(() => E.safeOwnership({ safes: [{ name: "x", amount: -1 }] })).toThrow();
    expect(() => E.safeOwnership({ safes: [{ name: "x", amount: 1, discount: 1 }] })).toThrow();
  });
  it("markdown includes a cap table", () => {
    const r = E.modelPricedRound({ capTable: base, round: { pricePerShare: 1, newInvestors: [{ name: "A", amount: 1 }] } });
    expect(r.markdown).toContain("| Holder | Class |");
  });
});
