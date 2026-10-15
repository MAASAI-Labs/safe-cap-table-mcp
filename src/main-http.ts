import http from "node:http";
import { handleMcp } from "./http.js";
const port = Number(process.env.PORT ?? 3000);
http.createServer((req, res) => {
  const url = req.url?.split("?")[0];
  if (url === "/mcp" || url === "/api/mcp") return void handleMcp(req, res).catch(e => { console.error(e); if (!res.headersSent) { res.statusCode = 500; res.end(); } });
  if (url === "/" || url === "/health") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ name: "safe-cap-table-mcp", status: "ok", mcp: "/mcp" })); }
  res.statusCode = 404; res.end("Not found");
}).listen(port, () => console.error(`safe-cap-table-mcp listening on http://localhost:${port}/mcp`));
