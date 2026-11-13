/** Oletusportti HTTP-tilalle (3000 on usein varattu, esim. Open WebUI). */
export const DEFAULT_HTTP_PORT = 3100;

/** Virheellinen ympäristömuuttuja; pääohjelma tulostaa viestin ilman pinojälkeä. */
export class InvalidEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEnvError";
  }
}

/**
 * Jäsentää MCP_HTTP_PORT-arvon tiukasti. Aiemmin `parseInt` hyväksyi esim.
 * arvon "3100abc" (→ 3100) ja "0" (→ käyttöjärjestelmän satunnainen portti,
 * jota kukaan asiakas ei löydä), ja "abc" kaatui Noden pinojälkeen.
 * Hyväksytään vain kokonaisluku 1–65535; tyhjä tai puuttuva = oletus.
 */
export function parseHttpPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_HTTP_PORT;
  const value = raw.trim();
  const port = /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidEnvError(
      `MCP_HTTP_PORT must be an integer between 1 and 65535 (got '${value.slice(0, 20)}'). Unset it to use the default ${DEFAULT_HTTP_PORT}.`,
    );
  }
  return port;
}
