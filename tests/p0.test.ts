import { describe, it, expect } from "vitest";
import * as E from "../src/engine";
const sum = (r: any) => r.capTable.reduce((a: number, x: any) => a + x.pctAfter, 0);
const ct = [{ name: "Founders", shares: 9_000_000 }, { name: "Pool", shares: 1_000_000, class: "pool" }];

describe("MFN adopts ONE later SAFE's full terms", () => {
  it("does not mix cap from one SAFE and discount from another", () => {
    const r = E.safeOwnership({ safes: [{ name: "M", amount: 1e5, mfn: true }, { name: "a", amount: 1e5, valuationCap: 5e6 }, { name: "b", amount: 1e5, valuationCap: 9e6, discount: 0.3 }] });
    expect(r.safes[0].valuationCap).toBe(5e6);
    expect((E.resolveMfn as any)([{ name: "M", amount: 1, mfn: true, type: "post-money" }, { name: "a", amount: 1, valuationCap: 5e6, type: "post-money", mfn: false }, { name: "b", amount: 1, valuationCap: 9e6, discount: 0.3, type: "post-money", mfn: false }])[0].discount).toBeUndefined();
  });
  it("keeps own terms when later SAFEs are worse", () => {
    const m = E.resolveMfn([{ name: "M", amount: 1, mfn: true, type: "post-money", valuationCap: 4e6 }, { name: "a", amount: 1, mfn: false, type: "post-money", valuationCap: 6e6 }]);
    expect(m[0].valuationCap).toBe(4e6);
  });
});

describe("AEON flagship: US$1.5M @ US$5M post cap, then US$500k extension @ US$7M", () => {
  // VERIFIED: ycombinator.com/documents FAQ + YC "Primer for post-money safe v1.1": ownership sold = amount / post-money cap; SAFEs on different caps add.
  it("30% + 7.142857% before the round", () => {
    const r = E.safeOwnership({ safes: [{ name: "AEON", amount: 1.5e6, valuationCap: 5e6 }, { name: "AEON ext", amount: 5e5, valuationCap: 7e6 }] });
    expect(r.safes[0].ownership).toBeCloseTo(0.3, 12);
    expect(r.safes[1].ownership).toBeCloseTo(1 / 14, 12);
  });
  it("converts in a $3M round at $15M pre with 10% pool; labels survive; sums to 100%", () => {
    const r = E.modelSequence({ capTable: ct, events: [
      { type: "safe", safe: { name: "AEON", amount: 1.5e6, valuationCap: 5e6 } },
      { type: "safe", safe: { name: "AEON ext", amount: 5e5, valuationCap: 7e6 } },
      { type: "priced_round", round: { preMoneyValuation: 15e6, newInvestors: [{ name: "Lead", amount: 3e6 }], targetPoolPercent: 0.1 }, advisors: [{ name: "Adv", percentOfPostFD: 0.01, fromPool: false }] },
      { type: "tranche", name: "T2", investors: [{ name: "Lead", amount: 1e6 }], pricePerShare: 2 },
    ] });
    const g = (n: string) => r.capTable.find(x => x.name === n)!;
    const preCap = 10_000_000 + g("AEON").after + g("AEON ext").after + (g("Pool").after - 1_000_000);
    expect(g("AEON").after / preCap).toBeCloseTo(0.3, 6);
    expect(g("AEON ext").after / preCap).toBeCloseTo(1 / 14, 6);
    expect(g("Adv").class).toBe("common (advisor)");
    expect(r.capTable.reduce((a, x) => a + x.pctAfter, 0)).toBeCloseTo(1, 12);
  });
});

describe("YC Primer for post-money safe v1.1, ABC Inc. example", () => {
  // VERIFIED: YC Primer v1.1: Investor A $200k @ $4M post = 5%; Investor B $800k @ $8M post = 10%; minimum 15% sold.
  it("5% + 10% = 15%", () => {
    const r = E.safeOwnership({ safes: [{ name: "A", amount: 2e5, valuationCap: 4e6 }, { name: "B", amount: 8e5, valuationCap: 8e6 }] });
    expect(r.safes[0].ownership).toBeCloseTo(0.05, 12); expect(r.safes[1].ownership).toBeCloseTo(0.1, 12); expect(r.combinedSafeOwnership).toBeCloseTo(0.15, 12);
  });
});

describe("Post-money SAFE conversion principle", () => {
  // VERIFIED (principle): YC Primer v1.1 + ycombinator.com/safe/calculator: post-money cap includes all SAFEs and existing pool, excludes new money and new pool. $1M/$10M figures are illustrative (not YC's own numbers).
  it("SAFE holds exactly amount/cap of pre-money capitalization", () => {
    const r = E.modelPricedRound({ capTable: ct, safes: [{ name: "S", amount: 1e6, valuationCap: 1e7 }], round: { preMoneyValuation: 4e7, newInvestors: [{ name: "A", amount: 1e7 }] } });
    expect(r.conversions[0].shares / (10_000_000 + r.conversions[0].shares)).toBeCloseTo(0.1, 6);
  });
});

describe("YC pre-money SAFE (v1.1) Company Capitalization", () => {
  // PARTLY VERIFIED: pre-money SAFE s.2 text as quoted by Pillar Legal (2023) and Pulley: excludes Converting Securities; pool increase included only to the extent Promised Options exceed the pre-increase pool. CONFLICT: the same Pillar table and Pulley say the pool increase is "Included". Original YC pre-money PDF no longer hosted; needs counsel confirmation. Promised-Options carve-out not modelled.
  it("cap price = cap / pre-round FD, ignoring other SAFEs and the new pool", () => {
    const r = E.modelPricedRound({ capTable: [{ name: "F", shares: 1e7 }], safes: [{ name: "P", type: "pre-money", amount: 1e6, valuationCap: 1e7 }, { name: "Q", type: "pre-money", amount: 1e6, valuationCap: 1e7 }], round: { preMoneyValuation: 3e7, newInvestors: [{ name: "A", amount: 5e6 }], targetPoolPercent: 0.1 } });
    expect(r.conversions[0].conversionPrice).toBeCloseTo(1, 12);
    expect(r.conversions[1].shares).toBe(1_000_000);
  });
});

describe("pro-rata", () => {
  // VERIFIED (principle): ycombinator.com/documents FAQ: pro rata = right to invest in the priced round to keep ownership %. Side-letter section text not fetched; exact Pro Rata Share definition UNVERIFIED.
  it("8% holder takes $400k of a $5M round", () => { expect(E.proRata({ currentOwnership: 0.08, roundSize: 5e6 }).amount).toBeCloseTo(4e5, 6); });
  it("rejects >= 100%", () => { expect(() => E.proRata({ currentOwnership: 1, roundSize: 1 })).toThrow(); });
});

describe("fee schedule (Lehman-style tiered)", () => {
  // VERIFIED: Investopedia "Lehman Formula" + Wikipedia "Lehman Formula" (5/4/3/2/1 on successive $1M bands; Wikipedia: $3M => $120,000). Retainer/warrant cases are hand-checked, no external source.
  const tiers = [{ upTo: 1e6, rate: 0.05 }, { upTo: 2e6, rate: 0.04 }, { upTo: 3e6, rate: 0.03 }, { upTo: 4e6, rate: 0.02 }, { upTo: null, rate: 0.01 }];
  it("Wikipedia worked example: $3M => $120k", () => { expect(E.feeSchedule({ amountRaised: 3e6, tiers }).successFee).toBeCloseTo(120_000, 6); });
  it("$5M raise => $150k success fee", () => { expect(E.feeSchedule({ amountRaised: 5e6, tiers }).successFee).toBeCloseTo(150_000, 6); });
  it("retainer credited and warrant coverage", () => {
    const r = E.feeSchedule({ amountRaised: 2e6, tiers, monthlyRetainer: 10_000, retainerMonths: 3, warrantCoveragePercent: 0.05, warrantStrikePrice: 1.25 });
    expect(r.successFee).toBeCloseTo(90_000); expect(r.successFeeDueAtClose).toBeCloseTo(60_000); expect(r.totalCashFees).toBeCloseTo(90_000);
    expect(r.warrantShares).toBe(80_000);
  });
  it("minimum fee applies", () => { expect(E.feeSchedule({ amountRaised: 1e5, tiers, minimumFee: 50_000 }).successFeeDueAtClose).toBe(50_000); });
});

describe("currency", () => {
  it("labels and converts", () => {
    expect(E.formatMoney(1000, "NGN", 1500)).toContain("1,500,000");
    expect(E.formatMoney(1e6, "USD")).toBe("$1,000,000.00");
  });
});

describe("property: ownership sums to 100% and no negative shares", () => {
  let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  it("200 random rounds", () => {
    for (let k = 0; k < 200; k++) {
      const safes = Array.from({ length: Math.floor(rnd() * 4) }, (_, j) => ({ name: "S" + j, amount: 1e5 + rnd() * 1e6, valuationCap: 2e7 + rnd() * 3e7, discount: rnd() < 0.5 ? 0.2 : undefined, type: (rnd() < 0.7 ? "post-money" : "pre-money") as any, mfn: rnd() < 0.2 }));
      const r = E.modelPricedRound({ capTable: ct, safes, round: { preMoneyValuation: 1e7 + rnd() * 5e7, newInvestors: [{ name: "A", amount: 1e6 + rnd() * 1e7 }], targetPoolPercent: rnd() < 0.5 ? 0.1 : undefined, poolTiming: rnd() < 0.5 ? "pre-money" : "post-money" } });
      expect(sum(r)).toBeCloseTo(1, 9);
      r.capTable.forEach(x => expect(x.after).toBeGreaterThanOrEqual(0));
    }
  });
});
