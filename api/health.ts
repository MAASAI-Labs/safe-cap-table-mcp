// Vercel Node.js function: health check at /health (rewritten from /health in vercel.json).
import type { IncomingMessage, ServerResponse } from "node:http";
import { VERSION } from "../src/version.js";
export default function health(_req: IncomingMessage, res: ServerResponse) {
  res.setHeader("content-type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(JSON.stringify({ status: "ok", name: "safe-cap-table-mcp", version: VERSION, mcp: "/mcp" }));
}
