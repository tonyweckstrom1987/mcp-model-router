// Korvaa kasetin pyynto-osoitteiden palvelinosan paikkamerkilla ja laskee avaimet uudelleen,
// jotta julkiseen repoon ei joudu oikeaa LiteLLM-osoitetta (esim. tailnetin nimea).
// Kaytto: node scripts/anonymize-cassette.mjs <kasetti.json> [paikkamerkki-base-url]
import { readFileSync, writeFileSync } from "node:fs";
import { requestKey } from "llm-cassette";

const [file, placeholder = "https://litellm.example/v1"] = process.argv.slice(2);
if (!file) {
  console.error("Kaytto: node scripts/anonymize-cassette.mjs <kasetti.json> [base-url]");
  process.exit(2);
}

const data = JSON.parse(readFileSync(file, "utf8"));
if (data.version !== 1 || !Array.isArray(data.entries)) {
  console.error("Tuntematon kasettimuoto");
  process.exit(2);
}

const models = new Set();
for (const e of data.entries) {
  const m = /^.*?(\/chat\/completions)$/.exec(e.request.url);
  if (!m) {
    console.error(`Odottamaton osoite (ei paattyy /chat/completions): ${e.request.url}`);
    process.exit(1);
  }
  e.request.url = placeholder.replace(/\/+$/, "") + m[1];
  e.key = requestKey(e.request.method, e.request.url, e.request.body);
  try {
    const model = JSON.parse(e.request.body ?? "{}").model;
    if (typeof model === "string") models.add(model);
  } catch {
    /* ei JSON-runkoa */
  }
}

const text = JSON.stringify(data, null, 2) + "\n";
if (/ts\.net|tailscale|bearer|api[_-]?key/i.test(text)) {
  console.error("VAROITUS: kasetti sisaltaa epailyttavan merkkijonon (ts.net / bearer / api key). Tiedostoa ei kirjoitettu.");
  process.exit(1);
}
writeFileSync(file, text, "utf8");
console.log(`Kasetti anonymisoitu: ${data.entries.length} merkintaa, osoite ${placeholder}`);
console.log(`Mallit: ${[...models].join(",")}`);
