#!/usr/bin/env node
// Smoke-test a running Hypit MCP server.
//   MCP_AUTH_TOKEN=... node scripts/smoke.mjs https://your-service.up.railway.app
// Lists tools, reads the Skill, creates a "smoke-test" project and runs `hypit paths` in it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = (process.argv[2] ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const token = process.env.MCP_AUTH_TOKEN;
if (!token) {
  console.error("Set MCP_AUTH_TOKEN.");
  process.exit(2);
}

const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "hypit-mcp-smoke", version: "0.1.0" });
await client.connect(transport);

const textOf = (result) => result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed:\n${textOf(result)}`);
  return result;
};

const { tools } = await client.listTools();
console.log(`tools (${tools.length}): ${tools.map((tool) => tool.name).join(", ")}`);

const docs = textOf(await call("hypit_docs"));
if (!docs.includes("name: hypit")) throw new Error("hypit_docs did not return SKILL.md");
console.log(`hypit_docs: ${docs.length} characters`);

await call("project_create", { name: "smoke-test" });
console.log("project_create: ok");

const paths = textOf(await call("hypit", { project: "smoke-test", args: ["paths"] }));
console.log(paths.split("\n").slice(0, 8).join("\n"));

await client.close();
console.log("smoke test passed");
