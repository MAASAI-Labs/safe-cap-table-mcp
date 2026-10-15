// Usage: node scripts/smoke.mjs [url]  (default http://localhost:3000/mcp)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const url = new URL(process.argv[2] ?? "http://localhost:3000/mcp");
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(url));
const { tools } = await client.listTools();
console.log("tools:", tools.map(t => t.name).join(", "));
const r = await client.callTool({ name: "model_priced_round", arguments: {
  capTable: [{ name: "Founders", shares: 9000000 }, { name: "Option pool", shares: 1000000, class: "pool" }],
  safes: [{ name: "Seed SAFE", amount: 1000000, valuationCap: 10000000 }],
  round: { roundName: "Series A", preMoneyValuation: 40000000, newInvestors: [{ name: "Lead", amount: 10000000 }] } } });
console.log(r.content[0].text);
const bad = await client.callTool({ name: "model_priced_round", arguments: { capTable: [{ name: "F", shares: 1 }], round: {} } });
console.log("error case:", bad.isError, bad.content[0].text);
await client.close();
