import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cachedNodeModules } from "../../../scripts/runtime-paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.resolve(here, "..");
const pluginRoot = path.resolve(mcpRoot, "..", "..");

async function loadSdk(nodeModules) {
  if (!nodeModules) return null;
  if (!fs.existsSync(path.join(nodeModules, "@modelcontextprotocol", "sdk", "package.json"))) return null;
  const requireFromCache = createRequire(path.join(nodeModules, ".sdk-loader.cjs"));
  const load = (id) => import(pathToFileURL(requireFromCache.resolve(id)).href);
  const [server, stdio, types] = await Promise.all([
    load("@modelcontextprotocol/sdk/server/index.js"),
    load("@modelcontextprotocol/sdk/server/stdio.js"),
    load("@modelcontextprotocol/sdk/types.js"),
  ]);
  return {
    Server: server.Server,
    StdioServerTransport: stdio.StdioServerTransport,
    CallToolRequestSchema: types.CallToolRequestSchema,
    ListToolsRequestSchema: types.ListToolsRequestSchema,
  };
}

let sdk = null;
try {
  sdk = await loadSdk(cachedNodeModules(pluginRoot));
} catch (error) {
  console.error(`[opentrons-mcp] Cached MCP SDK could not be loaded: ${error.message}`);
}

if (!sdk) {
  try {
    sdk = await loadSdk(path.join(mcpRoot, "node_modules"));
  } catch (error) {
    console.error(`[opentrons-mcp] Local MCP SDK could not be loaded: ${error.message}`);
  }
}

if (!sdk) {
  throw new Error([
    "The Model Context Protocol SDK is not installed for the Opentrons MCP server.",
    `Plugin root: ${pluginRoot}`,
    `Run: node "${path.join(pluginRoot, "scripts", "install-runtime.mjs")}"`,
    "Then restart your MCP client.",
  ].join("\n"));
}

export const { Server, StdioServerTransport, CallToolRequestSchema, ListToolsRequestSchema } = sdk;
