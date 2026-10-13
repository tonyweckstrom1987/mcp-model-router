import { Db } from "./db.js";
import { DAILY_TOKEN_BUDGET, budgetDay } from "./limits.js";

export interface Reservation {
  /**
   * Korjaa varauksen toteutuneeseen käyttöön. Jos käyttöä ei tiedetä
   * (usage puuttuu), varaus jää voimaan (fail closed).
   */
  settle(actualTokens: number | undefined): void;
}

export interface TokenBudget {
  /** Varaa tokeneita ENNEN kutsua. Heittää LimitExceededErrorin, jos päiväraja ylittyisi. */
  reserve(tokens: number): Reservation;
}

export function createTokenBudget(db: Db): TokenBudget {
  return {
    reserve(tokens: number): Reservation {
      const day = budgetDay(new Date());
      db.reserveTokens(day, tokens, DAILY_TOKEN_BUDGET);
      return {
        settle(actual) {
          if (actual === undefined || !Number.isFinite(actual) || actual < 0) return;
          db.adjustReservedTokens(day, Math.ceil(actual) - tokens);
        },
      };
    },
  };
}

let processBudgetDb: Db | undefined;

/**
 * Palauttaa budjetin annetulle tietokannalle. Jos kantaa ei ole annettu,
 * käytetään prosessin sisäistä muistikantaa - raja on silti voimassa eikä
 * sitä voi ohittaa jättämällä db pois.
 */
export function budgetFor(db?: Db): TokenBudget {
  if (db) return createTokenBudget(db);
  processBudgetDb ??= new Db(":memory:");
  return createTokenBudget(processBudgetDb);
}

/** Karkea, varovainen arvio syötteen tokeneista (ylimitoitus on turvallista: varaus korjataan kutsun jälkeen). */
export function estimateInputTokens(messages: Array<{ content: string }>): number {
  return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 3) + 4, 0);
}
