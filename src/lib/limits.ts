/**
 * Kovakoodatut kustannuskatot. Näitä ei voi muuttaa ympäristömuuttujalla,
 * konfiguraatiolla eikä työkalun parametrilla - vain muokkaamalla tätä
 * tiedostoa. Ylitys kielletään ennen mallikutsua.
 */

/** Suurin sallittu max_tokens yhdelle kutsulle. Jos kutsuja ei anna arvoa, käytetään tätä. */
export const MAX_TOKENS_PER_CALL = 4096;

/** Suurin sallittu mallikutsujen määrä yhdessä run_eval-ajossa (judge-kutsut mukaan lukien). */
export const MAX_CALLS_PER_EVAL_RUN = 200;

/** Päiväkohtainen tokenibudjetti (varatut + toteutuneet tokenit). */
export const DAILY_TOKEN_BUDGET = 1_000_000;

/** Aikavyöhyke, jonka mukaan "päivä" määritellään. Ainoa paikka, jossa päivä määritellään: budgetDay(). */
export const BUDGET_TIME_ZONE = "Europe/Helsinki";

/** Kustannuskaton ylitys. Kutsua ei ole tehty. Ei saa laukaista varamallin käyttöä. */
export class LimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimitExceededError";
  }
}

export const EMPTY_RESPONSE_CODE = "vastaus_tyhja";

/** Malli palautti tyhjän, vain välilyöntejä sisältävän tai puuttuvan vastauksen. */
export class EmptyResponseError extends Error {
  readonly code = EMPTY_RESPONSE_CODE;
  constructor(model: string) {
    super(`${EMPTY_RESPONSE_CODE}: malli '${model}' palautti tyhjän vastauksen`);
    this.name = "EmptyResponseError";
  }
}

/** Päivä (YYYY-MM-DD) budjetin kirjanpitoa varten, Europe/Helsinki-ajassa. */
export function budgetDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUDGET_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
