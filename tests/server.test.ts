import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server";
import { VERSION } from "../src/version";
import health from "../api/health";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));

async function client() { const [a, b] = InMemoryTransport.createLinkedPair(); const c = new Client({ name: "t", version: "1" }); await Promise.all([createServer().connect(a), c.connect(b)]); return c; }

describe("Version consistency", () => {
  it("VERSION constant matches package.json", () => {
    expect(VERSION).toBe(packageJson.version);
  });

  it("MCP server info version matches package.json", async () => {
    const c = await client();
    const serverInfo = await c.getServerVersion();
    expect(serverInfo.version).toBe(packageJson.version);
  });

  it("health endpoint version matches package.json", () => {
    const mockRes = {
      headers: {} as Record<string, string>,
      body: "",
      setHeader(key: string, value: string) { this.headers[key] = value; },
      end(data: string) { this.body = data; },
    };
    health({} as any, mockRes as any);
    const healthData = JSON.parse(mockRes.body);
    expect(healthData.version).toBe(packageJson.version);
  });
});

describe("MCP tools", () => {
  it("lists new tools", async () => { const t = (await (await client()).listTools()).tools.map(x => x.name); expect(t).toEqual(expect.arrayContaining(["pro_rata", "fee_schedule", "convert_currency"])); });
  it("pro_rata", async () => { const r: any = await (await client()).callTool({ name: "pro_rata", arguments: { currentOwnership: 0.08, roundSize: 5e6 } }); expect(r.content[0].text).toContain("$400,000"); });
  it("fee_schedule", async () => { const r: any = await (await client()).callTool({ name: "fee_schedule", arguments: { amountRaised: 5e6, tiers: [{ upTo: 1e6, rate: 0.05 }, { upTo: 2e6, rate: 0.04 }, { upTo: 3e6, rate: 0.03 }, { upTo: 4e6, rate: 0.02 }, { upTo: null, rate: 0.01 }] } }); expect(r.content[0].text).toContain("$150,000"); });
  it("convert_currency", async () => { const r: any = await (await client()).callTool({ name: "convert_currency", arguments: { amount: 1000, currency: "NGN", fxRate: 1500 } }); expect(r.content[0].text).toContain("1,500,000"); });
  it("bad input is a tool error", async () => { const r: any = await (await client()).callTool({ name: "pro_rata", arguments: { currentOwnership: 2, roundSize: 1 } }); expect(r.isError).toBe(true); });
});
