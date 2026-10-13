import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, extname } from "node:path";

/** Sallitut prompt-tiedoston päätteet (kirjainkoolla ei väliä). Vakio koodissa. */
const ALLOWED_EXTENSIONS = new Set([".json"]);

/**
 * Virheilmoitus on tarkoituksella kiinteä: se ei kerro kutsujalle polkua,
 * hakemiston sijaintia eikä sitä, mikä tarkistus hylkäsi polun.
 */
export const EVAL_PATH_REJECTED = "promptSetPath hylätty: tiedostoa ei sallita";

export function getEvalDirFromEnv(): string | undefined {
  const value = process.env.EVAL_DIR;
  return value && value.trim() !== "" ? value : undefined;
}

/**
 * Ratkaisee run_evalin prompt-tiedoston polun turvallisesti. Epäonnistuu
 * suljetusti: ilman EVAL_DIR-hakemistoa tai mistä tahansa virheestä polku
 * hylätään. Suhteelliset polut tulkitaan EVAL_DIR:in suhteen (ei cwd:n).
 * Vertailu tehdään realpathin jälkeen, joten ../-polut ja ulos johtavat
 * symlinkit eivät pääse läpi.
 */
export function resolveEvalPromptPath(requestedPath: string, evalDir: string | undefined): string {
  if (!evalDir) throw new Error(EVAL_PATH_REJECTED);
  if (typeof requestedPath !== "string" || requestedPath.trim() === "" || requestedPath.includes("\0")) {
    throw new Error(EVAL_PATH_REJECTED);
  }

  let realDir: string;
  let realFile: string;
  try {
    realDir = realpathSync(resolve(evalDir));
    realFile = realpathSync(resolve(realDir, requestedPath));
  } catch {
    throw new Error(EVAL_PATH_REJECTED);
  }

  const rel = relative(realDir, realFile);
  if (rel === "" || rel === ".." || rel.startsWith(".." + "/") || rel.startsWith(".." + "\\") || isAbsolute(rel)) {
    throw new Error(EVAL_PATH_REJECTED);
  }
  if (!ALLOWED_EXTENSIONS.has(extname(realFile).toLowerCase())) {
    throw new Error(EVAL_PATH_REJECTED);
  }
  return realFile;
}
