import type { CallLogRow, Db, EvalResultRow } from "./db.js";

/**
 * Kirjanpito on sivutoiminto: sen virhe (levy täynnä, SQLITE_BUSY, vain luku -kanta) ei saa
 * muuttaa jo onnistuneen mallikutsun lopputulosta. Ilman tätä kirjausvirhe päämallin
 * onnistumispolulla tulkittiin päämallin virheeksi ja varamallia kutsuttiin turhaan (maksullinen
 * kutsu), ja run_evalissa yksi kirjausvirhe kaatoi koko ajon muiden kutsujen jäädessä taustalle.
 * Virhe kirjoitetaan stderriin (ei stdoutiin: stdio-siirtotapa käyttää sitä protokollaan).
 */
function varoita(mita: string, err: unknown): void {
  const nimi = err instanceof Error ? err.name : typeof err;
  const viesti = err instanceof Error ? err.message : String(err);
  process.stderr.write(`mcp-model-router: ${mita} epäonnistui (${nimi}): ${viesti.slice(0, 200)}\n`);
}

export function logCallSafely(db: Db | undefined, row: CallLogRow): void {
  if (!db) return;
  try {
    db.insertCallLog(row);
  } catch (err) {
    varoita("kutsulokin kirjaus", err);
  }
}

export function logEvalResultSafely(db: Db | undefined, row: EvalResultRow): void {
  if (!db) return;
  try {
    db.insertEvalResult(row);
  } catch (err) {
    varoita("eval-tuloksen kirjaus", err);
  }
}
