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
  /**
   * Kutsutaan, jos kuunteluun ryhtyminen epäonnistuu (esim. EADDRINUSE).
   * Oletus: kirjataan vain virheen koodi tai tyyppi ja lopetetaan koodilla 1,
   * jotta systemd käynnistää palvelun uudelleen.
   */
  onListenError?: (err: Error) => void;
}

/** Osoitteet, joilla SDK:n localhostHostValidation riittää DNS rebinding -suojaksi. */
export const LOCALHOST_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "::1"];

/** Startup error that the CLI prints as a plain message (no stack trace). */
export class DnsRebindingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DnsRebindingConfigError";
  }
}

/**
 * Palauttaa sallitut Host-nimet tai undefined, jos riittää localhost-tarkistus.
 * Tyhjä lista tulkitaan asettamattomaksi. Muu kuin localhost-osoite ilman
 * sallittuja nimiä heittää DnsRebindingConfigErrorin.
 */
export function assertDnsRebindingProtection(host: string, allowedHosts: string[] | undefined): string[] | undefined {
  if (allowedHosts && allowedHosts.length > 0) return allowedHosts;
  if (LOCALHOST_HOSTS.includes(host)) return undefined;
  throw new DnsRebindingConfigError(
    `MCP_HTTP_HOST is ${host}, which is not a localhost address (127.0.0.1, localhost, ::1), and MCP_ALLOWED_HOSTS is not set. ` +
      `HTTP mode will not start without DNS rebinding protection. ` +
      `Set MCP_ALLOWED_HOSTS to the host names clients use in the Host header, comma-separated and without a port ` +
      `(for example MCP_ALLOWED_HOSTS=100.64.0.10,my-host.tailnet.ts.net), or bind to 127.0.0.1.`,
  );
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
  // Fail closed: muu kuin localhost-osoite ilman sallittuja Host-nimiä heittää
  // ennen kuin portti avataan (Tonyn päätös 22.11., A1058).
  const allowedHosts = assertDnsRebindingProtection(options.host, options.allowedHosts);
  if (allowedHosts) {
    app.use(hostHeaderValidation(allowedHosts));
  } else {
    app.use(localhostHostValidation());
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
      console.error("MCP request handling failed:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_req: unknown, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not supported in stateless mode." },
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
    console.error("HTTP request handling failed:", err);
    res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  });

  // Express 5 rekisteröi listen-callbackin myös 'error'-tapahtumaan
  // (node_modules/express/lib/application.js: server.once('error', done)),
  // joten callback saa virheen argumenttina eikä sitä saa käsitellä onnistumisena.
  return app.listen(options.port, options.host, (err?: Error) => {
    if (err) {
      const handler =
        options.onListenError ??
        ((e: Error) => {
          const code = (e as NodeJS.ErrnoException).code ?? e.name;
          console.error(`mcp-model-router: failed to start HTTP server (${code})`);
          process.exit(1);
        });
      handler(err);
      return;
    }
    console.error(`mcp-model-router: streamable HTTP kuuntelee osoitteessa http://${options.host}:${options.port}/mcp`);
  });
}
