#!/usr/bin/env node
import { ConfigNotFoundError, loadConfig } from "./config/load.js";
import { createServer } from "./server/createServer.js";
import { startStdioTransport } from "./transport/stdio.js";
import { startHttpTransport } from "./transport/http.js";
import { Db } from "./lib/db.js";
import { InvalidEnvError, parseHttpPort } from "./transport/port.js";

async function main(): Promise<void> {
  const transportKind = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
  // Portti tarkistetaan ennen asetusten latausta ja tietokannan avausta.
  const port = transportKind === "http" ? parseHttpPort(process.env.MCP_HTTP_PORT) : undefined;
  const config = loadConfig();
  const db = new Db(config.database.path);

  if (transportKind === "http" && port !== undefined) {
    const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
    const allowedHosts = process.env.MCP_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean);
    startHttpTransport(() => createServer(config, db), { host, port, allowedHosts, authToken: process.env.MCP_AUTH_TOKEN });
  } else if (transportKind === "stdio") {
    const server = createServer(config, db);
    await startStdioTransport(server);
  } else {
    throw new Error(`Tuntematon MCP_TRANSPORT-arvo '${transportKind}'. Käytä 'stdio' tai 'http'.`);
  }
}

main().catch((err) => {
  if (err instanceof ConfigNotFoundError || err instanceof InvalidEnvError) {
    console.error(`mcp-model-router: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  console.error("mcp-model-router käynnistys epäonnistui:", err);
  process.exitCode = 1;
});
