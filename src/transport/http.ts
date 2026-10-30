import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  hostHeaderValidation,
  localhostHostValidation,
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { assertValidAuthToken, bearerAuth } from "./auth.js";

export interface HttpTransportOptions {
  host: string;
  port: number;
  /** Sallitut Host-otsikot DNS rebinding -suojausta varten (esim. Tailscale MagicDNS -nimi). */
  allowedHosts?: string[];
  /** Pakollinen Bearer-token /mcp-päätepisteelle (vähintään 32 merkkiä). Ilman sitä palvelin ei käynnisty. */
  authToken: string | undefined;
}

/**
 * Käynnistää MCP-palvelimen streamable HTTP -siirtotavan päällä tilattomassa
 * tilassa (yksi transport per pyyntö), jotta useat agenttikontit voivat
 * kutsua samaa palvelinta samanaikaisesti Tailscale-verkon yli.
 */
export function startHttpTransport(createServer: () => McpServer, options: HttpTransportOptions): Server {
  // Fail closed: heittää ennen kuin mitään portteja avataan.
  const authToken = assertValidAuthToken(options.authToken);
  const app = express();

  // DNS rebinding -suoja kuten SDK:n createMcpExpressAppissa. Omaa sovellusta
  // käytetään, koska createMcpExpressApp asentaa express.json()-jäsentimen
  // sovellustasolle ennen tunnistusta (katselmointi 28.10., löydös 9).
  const localhostHosts = ["127.0.0.1", "localhost", "::1"];
  if (options.allowedHosts) {
    app.use(hostHeaderValidation(options.allowedHosts));
  } else if (localhostHosts.includes(options.host)) {
    app.use(localhostHostValidation());
  } else if (options.host === "0.0.0.0" || options.host === "::") {
    console.warn(
      `Varoitus: kuunnellaan osoitteessa ${options.host} ilman DNS rebinding -suojaa; aseta allowedHosts (MCP_ALLOWED_HOSTS).`,
    );
  }

  // Kattaa kaikki /mcp-metodit (POST, GET, DELETE); /healthz jää avoimeksi.
  // Tunnistus ajetaan ennen body-jäsennystä: tunnistamattoman pyynnön bodya
  // ei lueta eikä jäsennetä lainkaan.
  app.use("/mcp", bearerAuth(authToken));
  app.use("/mcp", express.json());

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.post("/mcp", async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // Siivous rekisteröidään ennen connectia, jotta se laukeaa myös, jos
    // yhteys sulkeutuu kesken käsittelyn tai käsittely heittää (löydös 8).
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    };
    res.on("close", cleanup);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      cleanup();
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

  const methodNotAllowed = (_req: unknown, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Metodi ei ole tuettu tilattomassa tilassa." },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  // Jäsennysvirheet (virheellinen JSON, liian suuri body) JSON-RPC-muodossa
  // ilman Expressin oletusvastauksen HTML-pinojälkeä.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 500;
    if ((err as { type?: unknown })?.type === "entity.parse.failed") {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
      return;
    }
    if (status >= 400 && status < 500) {
      res.status(status).json({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" }, id: null });
      return;
    }
    console.error("HTTP-pyynnön käsittely epäonnistui:", err);
    res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Sisäinen palvelinvirhe" }, id: null });
  });

  return app.listen(options.port, options.host, () => {
    console.error(`mcp-model-router: streamable HTTP kuuntelee osoitteessa http://${options.host}:${options.port}/mcp`);
  });
}
