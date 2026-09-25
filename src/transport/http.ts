import type { Server } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface HttpTransportOptions {
  host: string;
  port: number;
  /** Sallitut Host-otsikot DNS rebinding -suojausta varten (esim. Tailscale MagicDNS -nimi). */
  allowedHosts?: string[];
}

/**
 * Käynnistää MCP-palvelimen streamable HTTP -siirtotavan päällä tilattomassa
 * tilassa (yksi transport per pyyntö), jotta useat agenttikontit voivat
 * kutsua samaa palvelinta samanaikaisesti Tailscale-verkon yli.
 */
export function startHttpTransport(createServer: () => McpServer, options: HttpTransportOptions): Server {
  const app = createMcpExpressApp({ host: options.host, allowedHosts: options.allowedHosts });

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.post("/mcp", async (req, res) => {
    const server = createServer();
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (err) {
      console.error("MCP-pyynnön käsittely epäonnistui:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Sisäinen palvelinvirhe" },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_req: unknown, res: import("express").Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Metodi ei ole tuettu tilattomassa tilassa." },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app.listen(options.port, options.host, () => {
    console.error(`mcp-model-router: streamable HTTP kuuntelee osoitteessa http://${options.host}:${options.port}/mcp`);
  });
}
