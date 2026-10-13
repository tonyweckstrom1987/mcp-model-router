import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/** Tokenin vähimmäispituus. Vakio koodissa, ei ympäristömuuttujaa. */
export const MIN_AUTH_TOKEN_LENGTH = 32;

/**
 * Tarkistaa, että tokeni on asetettu ja riittävän pitkä. Virheilmoitus ei
 * sisällä tokenia eikä sen pituutta.
 */
export function assertValidAuthToken(token: string | undefined): string {
  if (token === undefined || token.length < MIN_AUTH_TOKEN_LENGTH) {
    throw new Error(`MCP_AUTH_TOKEN puuttuu tai on alle ${MIN_AUTH_TOKEN_LENGTH} merkkiä; HTTP-tila ei käynnisty ilman sitä`);
  }
  return token;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Vertailu on vakioaikainen ja toimii eri pituisilla syötteillä, koska
 * molemmat hajautetaan ensin samanpituisiksi (SHA-256).
 */
export function tokensMatch(provided: string, expected: string): boolean {
  return timingSafeEqual(digest(provided), digest(expected));
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  return match ? match[1] : null;
}

/**
 * Express-middleware: vaatii `Authorization: Bearer <token>`. Puuttuva,
 * väärän skeeman tai väärä token antaa täsmälleen saman 401-vastauksen,
 * joka ei paljasta syytä.
 */
export function bearerAuth(expectedToken: string) {
  assertValidAuthToken(expectedToken);
  return (req: Request, res: Response, next: NextFunction): void => {
    const provided = extractBearer(req.headers.authorization);
    if (provided !== null && tokensMatch(provided, expectedToken)) {
      next();
      return;
    }
    res.setHeader("WWW-Authenticate", "Bearer");
    res.status(401).json({ error: "unauthorized" });
  };
}
