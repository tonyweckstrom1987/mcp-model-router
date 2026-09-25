#!/usr/bin/env node
import { loadConfig } from "./config/load.js";
import { createServer } from "./server/createServer.js";
import { startStdioTransport } from "./transport/stdio.js";
import { startHttpTransport } from "./transport/http.js";
import { Db } from "./lib/db.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new Db(config.database.path);
  const transportKind = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();

  if (transportKind === "http") {
    const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
    const port = Number.parseInt(process.env.MCP_HTTP_PORT ?? "3000", 10);
    const allowedHosts = process.env.MCP_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean);
    startHttpTransport(() => createServer(config, db), { host, port, allowedHosts });
  } else if (transportKind === "stdio") {
    const server = createServer(config, db);
    await startStdioTransport(server);
  } else {
    throw new Error(`Tuntematon MCP_TRANSPORT-arvo '${transportKind}'. Käytä 'stdio' tai 'http'.`);
  }
}

main().catch((err) => {
  console.error("mcp-model-router käynnistys epäonnistui:", err);
  process.exitCode = 1;
});
