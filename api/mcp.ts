// Vercel Node.js function: exposes the MCP server at /api/mcp (rewritten from /mcp in vercel.json).
import { handleMcp } from "../src/http.js";
export default handleMcp;
