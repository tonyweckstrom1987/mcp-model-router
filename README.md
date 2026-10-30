# mcp-model-router

[![CI](https://github.com/tonyweckstrom1987/mcp-model-router/actions/workflows/ci.yml/badge.svg)](https://github.com/tonyweckstrom1987/mcp-model-router/actions/workflows/ci.yml) ![Lisenssi: MIT](https://img.shields.io/badge/lisenssi-MIT-blue.svg)

> **English summary:** An MCP server that *complements* LiteLLM instead of replacing it. It (1) picks a model by task type from `config.yaml`, (2) reads usage and budget from LiteLLM or OpenRouter, and (3) runs the same prompt set across several models and compares cost, latency and quality. Works over stdio or streamable HTTP; SQLite stores only call logs and eval results. Details below in Finnish.

**Teknologiat:** TypeScript, Node.js 22/24, Model Context Protocol (stdio ja streamable HTTP), SQLite, vitest. Lisenssi: [LICENSE](./LICENSE).

**Sisältö:** [Nopea kokeilu](#nopea-kokeilu) · [Kokeile ilman avainta](#kokeile-ilman-llm-avainta) · [Arkkitehtuuri](#arkkitehtuuri) · [Asennus](#asennus) · [MCP-työkalut](#mcp-työkalut) · [Mitattu vertailu](#esimerkki-mitattu-vertailu) · [Claude Desktop / Cursor](#claude-desktop--cursor--asetus) · [Proxmox-LXC](#ajaminen-proxmox-lxcssä) · [Tietoturva](#tietoturva) · [Tunnetut rajoitukset](#tunnetut-rajoitukset)

MCP-palvelin, joka **täydentää LiteLLM:ää eikä korvaa sitä**. LiteLLM/OpenRouter
hoitavat jo agenttikohtaiset avaimet ja kulukatot - tämä palvelin ei rakenna
niitä uudelleen. Se tekee kolme asiaa:

1. **Mallin valinta tehtävätyypin mukaan** - lukee `config.yaml`:sta
   tehtävätyyppikohtaiset mallit (esim. `general`, `code`, `writing`,
   `orchestration`) ja kutsuu niitä OpenAI-yhteensopivan `/chat/completions`
   -rajapinnan kautta. Base URL ja avain tulevat ympäristömuuttujista, ja
   rajapinta voi olla joko LiteLLM-proxy tai suoraan OpenRouter. Ei suoria
   Anthropic-kutsuja. Jos päämalli epäonnistuu, käytetään konfiguroitua
   varamallia.
2. **Kulutus ja budjetti** - lukee ne suoraan LiteLLM:n (`/user/info`) tai
   OpenRouterin (`/credits`) rajapinnasta. Ei omaa kulutuskirjanpitoa.
3. **Eval-vertailu** - ajaa saman prompt-sarjan (JSON-tiedosto) usealla
   mallilla ja raportoi hinnan, viiveen ja vastauksen rinnakkain, jotta
   halvempi malli voidaan valita mitattuun laatuun perustuen. Laatu
   arvioidaan yksinkertaisella sisältää/vastaa-tarkistuksella ja
   valinnaisella LLM-tuomarilla.

SQLite-tietokantaa käytetään **vain** kutsulokille ja eval-tuloksille - ei
kulutuksen tai budjetin kirjanpitoon.

## Nopea kokeilu

Ensimmäinen `route_and_complete`-kutsu HTTP-tilassa
(oleta, että LiteLLM pyörii jo osoitteessa `http://localhost:4000` ja siinä
on ainakin `general`-tehtävän malli konfiguroitu):

```bash
npm install && npm run build
cp config.example.yaml config.yaml   # muokkaa tarpeen mukaan
read -s -p "LLM_API_KEY: " LLM_API_KEY; echo
export LLM_API_KEY   # tai ympäristötiedostoon; älä kirjoita avainta komentoriville
export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"   # pakollinen HTTP-tilassa, väh. 32 merkkiä
LLM_BASE_URL=http://localhost:4000 MCP_TRANSPORT=http MCP_HTTP_PORT=3100 npm start &
curl -s -X POST http://127.0.0.1:3100/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"route_and_complete","arguments":{"taskType":"general","prompt":"Sano hei suomeksi"}}}'
```

Viimeinen komento (`curl`) tekee `tools/call`-pyynnön palvelimen `/mcp`-päätepisteeseen ja
tulostaa vastauksen (streamable HTTP -tapahtumavirtana). Tarkemmat
ympäristömuuttujat, `stdio`-siirtotapa ja `GET /healthz` -terveystarkastus:
ks. [Asennus](#asennus) ja [Ajaminen](#ajaminen).

## Kokeile ilman LLM-avainta

`list_models` lukee vain `config.yaml`:n, joten sen voi kokeilla ilman LiteLLM:ää tai API-avainta. Stdio-tilassa palvelin lukee JSON-RPC-viestit stdinistä (`sleep 2` pitää putken auki, kunnes vastaus on tullut):

Komento käyttää `dist/index.js`:ää, joten aja ensin `npm install && npm run build` (ks. [Asennus](#asennus)).

```bash
cp config.example.yaml config.yaml
(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"kokeilu","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_models","arguments":{}}}'; sleep 2) | node dist/index.js
```

Viimeisen rivin vastauksen tekstiosa `config.example.yaml`:lla:

```
Tehtävätyypeittäin määritellyt mallit:
- general: openrouter/deepseek/deepseek-v4.1-flash (varamalli: openrouter/qwen/qwen3-flash)
- code: openrouter/qwen/qwen3-coder (varamalli: openrouter/deepseek/deepseek-v4.1-flash)
- writing: openrouter/anthropic/claude-3.5-sonnet (varamalli: openrouter/openai/gpt-4o-mini)
- orchestration: openrouter/openai/gpt-4o (varamalli: openrouter/anthropic/claude-3.5-sonnet)
```

## Arkkitehtuuri

```
                       ┌─────────────────────────┐
 AgentScope-agentti ──▶│   mcp-model-router (MCP) │
 (tai muu MCP-klientti) │                          │
                       │  route_and_complete       │
                       │  list_models              │
                       │  get_usage                │──▶ LiteLLM-proxy / OpenRouter
                       │  run_eval                 │      (OpenAI-yhteensopiva API)
                       └───────────┬──────────────┘
                                   │
                                   ▼
                         SQLite (call_log, eval_result)
```

- **Siirtotavat**: stdio (paikalliseen käyttöön, esim. Claude Desktop/Cursor)
  ja streamable HTTP (jotta muut kontit tavoittavat palvelimen Tailscale-
  verkossa). HTTP-tila on tilaton (`sessionIdGenerator: undefined`) - jokainen
  pyyntö saa oman transport-instanssinsa, joten useat agentit voivat kutsua
  palvelinta yhtäaikaisesti. `/mcp` vaatii Bearer-tokenin (`MCP_AUTH_TOKEN`),
  ja verkkotason rajaus (Tailscale ACL:t) on sen lisäksi - ks.
  [Tietoturva](#tietoturva).
- **Konfiguraatio**: `config.yaml` (ympäristömuuttujaviittauksin, ei
  salaisuuksia tiedostossa) + varsinaiset arvot ympäristömuuttujista.
- **Kustannuskatot ovat kovakoodattuja** (`src/lib/limits.ts`): `maxTokens`
  on valinnainen parametri, mutta sen yläraja on 4096 ja päiväkohtainen
  tokenibudjetti rajaa kokonaiskulutuksen - ks. [Tietoturva](#tietoturva).

## Asennus

Vaatii Node.js 22.12 tai uudemman (22 tai 24).

```bash
npm install
cp config.example.yaml config.yaml   # muokkaa tarpeen mukaan
npm run build
```

Ympäristömuuttujat (esimerkkiarvot, ei salaisuuksia repossa):

| Muuttuja           | Kuvaus                                                        | Oletus                    |
|---------------------|----------------------------------------------------------------|----------------------------|
| `LLM_BASE_URL`      | OpenAI-yhteensopivan rajapinnan base URL                       | `http://localhost:4000`   |
| `LLM_API_KEY`       | Avain edelliseen rajapintaan                                   | (tyhjä)                   |
| `LLM_PROVIDER_KIND` | `litellm` tai `openrouter` - katso [Mallitunnisteet: LiteLLM vs. suora OpenRouter](#mallitunnisteet-litellm-vs-suora-openrouter) | `litellm` |
| `USAGE_BASE_URL`    | Kulutusrajapinnan base URL (yleensä sama kuin `LLM_BASE_URL`)   | `http://localhost:4000`   |
| `USAGE_API_KEY`     | Avain kulutusrajapintaan                                       | (tyhjä)                   |
| `CONFIG_PATH`       | Polku `config.yaml`-tiedostoon                                 | `config.yaml`              |
| `DB_PATH`           | SQLite-tiedoston polku                                         | `./data/mcp-model-router.sqlite` |
| `MCP_TRANSPORT`     | `stdio` tai `http`                                              | `stdio`                    |
| `MCP_HTTP_HOST`     | HTTP-siirtotavan bind-osoite                                    | `127.0.0.1`                |
| `MCP_HTTP_PORT`     | HTTP-siirtotavan portti (oletus vaihdettu 3100:aan, koska 3000 on usein varattu esim. Open WebUI:lle) | `3100`                     |
| `MCP_AUTH_TOKEN`    | **Pakollinen HTTP-tilassa**: Bearer-token `/mcp`-päätepisteelle, vähintään 32 merkkiä. Ilman sitä palvelin ei käynnisty | (ei asetettu) |
| `EVAL_DIR`          | Ainoa hakemisto, josta `run_eval` lukee prompt-tiedostoja (vain `.json`). Ilman tätä `run_eval` kieltäytyy | (ei asetettu) |
| `MCP_ALLOWED_HOSTS` | Pilkulla eroteltu lista sallittuja Host-otsikoita (DNS-rebinding-suojaus) | (ei asetettu)      |

### Ajaminen

```bash
# stdio (esim. Claude Desktop / Cursor)
npm start

# streamable HTTP (oletus: vain tämä kone; muille Tailscale-kontteille aseta MCP_HTTP_HOST oman Tailscale-osoitteen mukaan, ei 0.0.0.0)
# MCP_AUTH_TOKEN on pakollinen (väh. 32 merkkiä), esim. openssl rand -hex 32
MCP_TRANSPORT=http MCP_HTTP_HOST=127.0.0.1 MCP_HTTP_PORT=3100 MCP_AUTH_TOKEN=... npm start
```

HTTP-tilassa palvelin vastaa osoitteessa `http://<host>:<port>/mcp` ja
tarjoaa lisäksi `GET /healthz` -terveystarkastuksen. Stdio-tilassa vastaava
`tools/call`-pyyntö syötetään palvelimelle stdinistä yksittäisenä
JSON-RPC-viestinä (ks. [Nopea kokeilu](#nopea-kokeilu) HTTP-versiosta).

## config.yaml-esimerkki

Ks. koko esimerkki tiedostossa [`config.example.yaml`](./config.example.yaml).
Tiivistettynä:

```yaml
provider:
  baseUrl: ${LLM_BASE_URL:-http://localhost:4000}
  apiKey: ${LLM_API_KEY:-}
  kind: ${LLM_PROVIDER_KIND:-litellm}   # litellm | openrouter

tasks:
  general:
    model: openrouter/deepseek/deepseek-v4.1-flash
    fallbackModel: openrouter/qwen/qwen3-flash
  code:
    model: openrouter/qwen/qwen3-coder
    fallbackModel: openrouter/deepseek/deepseek-v4.1-flash
  orchestration:
    model: openrouter/openai/gpt-4o
    timeoutMs: 120000   # ohittaa provider.timeoutMs:n tälle tehtävätyypille

usage:
  provider: litellm   # litellm | openrouter
  baseUrl: ${USAGE_BASE_URL:-http://localhost:4000}
  apiKey: ${USAGE_API_KEY:-}
  # timeoutMs: 15000  # kulutusrajapinnan aikakatkaisu (oletus 15 s)

eval:
  judge:
    enabled: false
    model: openrouter/openai/gpt-4o-mini   # eri malli kuin arvioitavat mallit, ks. alla
  concurrency: 4   # montako (malli, prompt) -kutsua ajetaan samanaikaisesti
  pricing:
    openrouter/deepseek/deepseek-v4.1-flash:
      inputPerMillionUsd: 0.2
      outputPerMillionUsd: 0.8

database:
  path: ${DB_PATH:-./data/mcp-model-router.sqlite}
```

### Mallitunnisteet: LiteLLM vs. suora OpenRouter

`tasks`-lohkon mallitunnisteet kirjoitetaan aina LiteLLM:n käyttämässä
muodossa, esim. `openrouter/deepseek/deepseek-v4.1-flash`. `openrouter/`-
etuliite on LiteLLM:n oma tapa kertoa, että pyyntö reititetään OpenRouterin
kautta - se ei ole osa OpenRouterin omaa mallitunnistetta.

- **`provider.kind: litellm`** (oletus, `LLM_BASE_URL` osoittaa LiteLLM-
  proxyyn): tunniste lähetetään sellaisenaan, etuliite mukaan lukien.
- **`provider.kind: openrouter`** (`LLM_BASE_URL` osoittaa suoraan
  `https://openrouter.ai/api/v1`): reititin karsii `openrouter/`-etuliitteen
  automaattisesti ennen rajapintakutsua (ks. `src/lib/modelId.ts`), joten
  sama `config.yaml` toimii sellaisenaan molemmilla - vain
  `LLM_BASE_URL`/`LLM_PROVIDER_KIND` vaihtuvat.

### Tehtävätyyppikohtainen aikakatkaisu (`timeoutMs`)

`tasks.<taskType>.timeoutMs` on valinnainen ja ohittaa `provider.timeoutMs`:n
vain kyseiselle tehtävätyypille (vaikuttaa `route_and_complete`-kutsuihin,
sekä päämalliin että varamalliin). Oletuksena kaikki tehtävätyypit käyttävät
`provider.timeoutMs`:ää (oletus 60000 ms).

Tämä on hyödyllinen erityisesti päättelymalleille (reasoning-malleilla), jotka
voivat kestää huomattavasti kauemmin monimutkaisissa pilkkomis- tai
orkestrointitehtävissä kuin yksinkertaisissa yleistiedon tai lyhyen koodin
tehtävissä - ks. [Esimerkki: mitattu vertailu](#esimerkki-mitattu-vertailu),
jossa "pilkkominen"-tehtävätyyppi aiheutti aikakatkaisuja 60 s
oletusaikakatkaisulla:

```yaml
tasks:
  orchestration:
    model: openrouter/deepseek/deepseek-v4.1-flash
    timeoutMs: 120000   # 2 min, oletuksen sijaan 60000 ms (1 min)
```

## MCP-työkalut

| Työkalu              | Kuvaus                                                                 |
|-----------------------|-------------------------------------------------------------------------|
| `route_and_complete`  | Valitsee mallin `taskType`-parametrin mukaan ja täydentää promptin. Käyttää varamallia tarvittaessa. |
| `list_models`         | Listaa `config.yaml`:n tehtävätyypit ja niihin liitetyt mallit.        |
| `get_usage`           | Palauttaa kulutuksen ja budjetin tilan LiteLLM:stä/OpenRouterista.     |
| `run_eval`             | Ajaa JSON-prompt-sarjan usealla mallilla ja raportoi hinnan/viiveen/laadun. |

Eval-prompt-tiedoston muoto, ks. esimerkki
[`examples/eval-prompts.example.json`](./examples/eval-prompts.example.json):

```json
[
  { "id": "p1", "prompt": "Mikä on Suomen pääkaupunki?", "expectedContains": "Helsinki" }
]
```

Laajempi, 15-20 suomenkielisen promptin esimerkkisarja neljälle tehtävätyypille
(yleinen tieto, koodaus, kirjoitus/tiivistys, tehtävän pilkkominen) löytyy
tiedostosta [`examples/eval-prompts.fi.json`](./examples/eval-prompts.fi.json).

**Prompt-tiedostojen tarkistus (evalkit):** `npm run eval:validate` tarkistaa esimerkkitiedostot
[evalkit](https://github.com/tonyweckstrom1987/evalkit)-työkalulla ilman verkkokutsuja ja kuluja
(muoto, kaksoisid:t, virheelliset lausekkeet). CI ajaa sen jokaisella pushilla, joten rikkinäinen
prompt-tiedosto huomataan ennen kuin `run_eval` kohtaa sen. evalkit lukee tämän taulukkomuodon
(`expectedContains`, `category`) sellaisenaan.

**Tallennetut vastaukset (llm-cassette):** `test/cassettes/fi.json` sisältää oikean mallin (`deepseek-flash`)
vastaukset 20 promptiin, ja `test/cassettes/fi.baseline.json` on niistä lasketut tulokset. `npm run eval:replay`
toistaa vastaukset ilman verkkoa ja avainta ja vertaa baselineen; CI ajaa sen, joten arviointilogiikan
regressio (esim. tarkistusten muutos) kaatuu CI:ssä. Uusi tallennus (vaatii oman LiteLLM-avaimen, kuluu senttejä):
aseta `EVALKIT_BASE_URL`, `EVALKIT_MODELS` ja `LLM_API_KEY`, aja `npm run eval:record` ja sen jälkeen
`npm run eval:anonymize`, joka korvaa oikean osoitteen paikkamerkillä ja kieltäytyy, jos kasetissa on `ts.net`
tai avaimen näköinen merkkijono.

### Eval-ajo (`run_eval`)

`run_eval` on MCP-työkalu, ei erillinen CLI-komento - se kutsutaan samalla
tavalla kuin muutkin työkalut (`tools/call`, ks. [Nopea
kokeilu](#nopea-kokeilu)). Esimerkki HTTP-tilassa, kahdella mallilla ja
`eval-prompts.fi.json`-sarjalla:

Mallit rajataan: `run_eval` hyväksyy vain `config.yaml`:n `tasks`-osion mallit (`model`,
`fallbackModel`) ja listan `eval.allowedModels`. Muu malli hylätään ennen yhtään kutsua, jotta
tokenin haltija ei voi ohjata kutsuja proxyn kalleimpaan malliin.

```bash
# palvelin käynnistetty ympäristömuuttujalla EVAL_DIR=/polku/mcp-model-router/examples
curl -s -X POST http://127.0.0.1:3100/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{
      "name":"run_eval",
      "arguments":{
        "promptSetPath":"eval-prompts.fi.json",
        "models":["openrouter/deepseek/deepseek-v4.1-flash","openrouter/qwen/qwen3-flash"],
        "judge": false
      }
    }
  }'
```

- `promptSetPath` tulkitaan suhteessa `EVAL_DIR`-hakemistoon (ks.
  [Tietoturva](#tietoturva)); polku hakemiston ulkopuolelle hylätään.
- `models`-lista käyttää samoja LiteLLM `model_name`-aliaksia kuin
  `config.yaml`:n `tasks`-lohko (ks. [Tunnetut
  rajoitukset](#tunnetut-rajoitukset)) - ei tarvitse olla sama malli kuin
  jonkin `taskType`:n oletusmalli.
- `judge`-parametri (valinnainen) ohittaa `config.yaml`:n
  `eval.judge.enabled`-asetuksen yksittäiselle ajolle. Kun tuomari on
  päällä, jokainen vastaus lähetetään lisäksi `eval.judge.model`:lle
  arvioitavaksi asteikolla 1-5 (`config.yaml`:n `eval.judge.systemPrompt`
  tai oletusarvo) - tämä tekee saman määrän ylimääräisiä mallikutsuja kuin
  on prompt-tapauksia, joten se maksaa ja kestää enemmän.
- Jos `db`-instanssi on käytössä (näin on aina, kun palvelin käynnistetään
  `dist/index.js`:llä - ks. `src/index.ts`), jokainen ajo ja tulosrivi
  tallennetaan SQLiteen (`eval_run`/`eval_result`-taulut) `DB_PATH`:n
  osoittamaan tiedostoon, joten ajoja voi vertailla jälkikäteen myös
  suoraan tietokannasta.
- Eval voi tehdä paljon mallikutsuja: esim. 2 mallia × 20 promptia = 40
  (malli, prompt) -paria, ja jokainen kutsu voi kestää useita sekunteja (tai
  `provider.timeoutMs`/tehtävätyypin oman `timeoutMs`:n verran, jos malli
  jumiutuu) - ks. [Esimerkki: mitattu vertailu](#esimerkki-mitattu-vertailu).
  `judge: true` lähes tuplaa ajoajan, koska jokainen vastaus arvioidaan vielä
  erikseen ylimääräisellä mallikutsulla.

**Rinnakkaisajo (`eval.concurrency`)**

`run_eval` ajaa (malli, prompt) -parit rinnakkain enintään
`config.yaml`:n `eval.concurrency`-asetuksen verran samanaikaisesti
(oletus 4, minimi 1). Toteutus on yksinkertainen rajoitettu työjono
(`mapWithConcurrency`, ks. `src/eval/runEval.ts`) ilman uusia riippuvuuksia:
kiinteä määrä "workereita" nostaa jonosta seuraavan käsittelemättömän
tehtävän kerrallaan, kunnes jono on tyhjä.

Kutsut ovat käytännössä koko ajan I/O-odotusta (verkkovastaus mallilta),
eivät CPU-työtä, joten rinnakkaisajo lyhentää kokonaisajoaikaa suoraan
suhteessa `concurrency`-arvoon - esim. 2 mallia × 20 promptia × judge
päällä (40 vastauskutsua + 40 judge-kutsua = 80 kutsua) kesti aiemmin
peräkkäin ajettuna noin 12 minuuttia; `concurrency: 4`:llä samat kutsut
menevät neljä kerrallaan, mikä lyhentää ajoaikaa merkittävästi samalla
prompt-sarjalla ja mallivalinnalla.

Huomioita:

- **Tulosten järjestys säilyy** riippumatta siitä, missä järjestyksessä
  yksittäiset kutsut valmistuvat: `cases`-taulukko on aina samassa
  järjestyksessä kuin peräkkäin ajettuna (malli ulompana, prompt sisempänä,
  `input.models`/prompt-tiedoston järjestyksessä).
- **Virheenkäsittely on edelleen per kutsu**: yhden kutsun aikakatkaisu tai
  muu virhe (myös judge-kutsun virhe) ei keskeytä muita rinnakkaisia tai
  jonossa odottavia kutsuja - se näkyy vain kyseisen tapauksen `error`-
  kentässä, kuten peräkkäisessäkin ajossa.
- **Miksi oletus on 4, ei enemmän**: liian suuri rinnakkaisuus voi
  ylikuormittaa LiteLLM-proxyn tai OpenRouterin rate limitit, jolloin osa
  kutsuista alkaa epäonnistua 429-virheillä sen sijaan, että eval oikeasti
  nopeutuisi. Nosta arvoa varovasti oman proxyn/API-avaimen rajojen
  mukaan, tai laske se `1`:een, jos haluat täysin peräkkäisen (deterministisen
  ajoituksen kannalta yksinkertaisimman) ajon esim. vianetsintää varten.

**Tulosten lukeminen** (`EvalReport`, ks. `src/eval/runEval.ts`):

- `cases`: yksi rivi per (malli, prompt) - sisältää `latencyMs`,
  `response`-tekstin, `passed` (`true`/`false`/`null` jos
  `expectedContains`-kenttää ei annettu kyseiselle promptille),
  `judgeScore` (1-5 tai `null`), `priceUsd` (`null`, jos mallille ei ole
  hinnastoa `config.yaml`:n `eval.pricing`-lohkossa) ja `error`
  (virheviesti tai `null`).
- `perModel`: yhteenveto mallia kohden - `avgLatencyMs`, `passRate`
  (`expectedContains`-läpäisyosuus 0-1 **virheelliset kutsut pois
  laskettuna**, `null` jos yhdessäkään promptissa ei ollut
  `expectedContains`-kenttää), `avgJudgeScore`, `avgPriceUsd` ja
  `errorCount`/`caseCount`. Tämä on nopein tapa verrata malleja: matalampi
  `avgPriceUsd` ja `avgLatencyMs` samalla kun `passRate`/`avgJudgeScore`
  pysyy riittävän korkeana kertoo, mikä malli kannattaa valita
  `config.yaml`:n `tasks`-lohkoon.
- `perTaskType`: sama yhteenveto ryhmiteltynä (malli, tehtävätyyppi)
  -pareittain. Tehtävätyyppi päätellään promptin `id`:n etuliitteestä
  pudottamalla lopusta `-<numero>`, esim. `"yleinen-01"` → `"yleinen"`,
  `"pilkkominen-05"` → `"pilkkominen"` (ks.
  `taskTypeFromPromptId` tiedostossa `src/eval/runEval.ts`) - tämä ei liity
  `config.yaml`:n `tasks`-avaimiin, vaan on pelkkä nimeämiskäytäntö
  prompt-tiedostossa. Jokainen rivi sisältää:
  - `caseCount`, `errorCount` - montako tapausta ja niistä montako virheitä.
  - `passedCount`/`expectedCount` - montako läpäisi avainsanatarkistuksen
    niistä tapauksista, joissa `expectedContains` oli annettu (= "läpäisty/n").
  - `passRateExcludingErrors` - läpäisyosuus laskettuna vain onnistuneista
    kutsuista (virheelliset kutsut pois sekä osoittajasta että
    nimittäjästä). Kertoo vastauksen laadun, kun malli ylipäätään vastasi.
  - `passRateIncludingErrors` - läpäisyosuus laskettuna niin, että virheet
    (esim. aikakatkaisu) lasketaan läpäisemättömiksi (mukana nimittäjässä).
    Kertoo tehtävätyypin kokonaisluotettavuuden mallilla.
  - `avgLatencyMs`, `avgPriceUsd` - kuten `perModel`:ssa, mutta rajattuna
    tähän tehtävätyyppiin.
- MCP-työkalun tekstivastaus tiivistää sekä `perModel`- että
  `perTaskType`-rivit ihmisluettavaksi; koko `EvalReport` (mukaan lukien
  `cases`) on saatavilla ohjelmallisesti `structuredContent`-kentässä.

**Judge-tila (`eval.judge`) - luotettavampi laatumittari**

`expectedContains`-avainsanatarkistus on karkea: se hylkää hyvänkin
vastauksen, jos se ei sisällä täsmälleen odotettua sanaa (ks. [Esimerkki:
mitattu vertailu](#esimerkki-mitattu-vertailu) - erityisesti
kirjoitus/tiivistystehtävissä tämä antaa harhaanjohtavan matalan
läpäisyprosentin). LLM-tuomari arvioi vastauksen laadun asteikolla 1-5
riippumatta siitä, osuuko vastaus täsmälleen odotettuun sanamuotoon, ja on
siksi luotettavampi mittari erityisesti avoimissa (kirjoitus-, tiivistys-,
pilkkomis-) tehtävissä.

Ota judge käyttöön joko pysyvästi `config.yaml`:ssa tai yksittäiselle ajolle:

```yaml
eval:
  judge:
    enabled: true
    model: openrouter/openai/gpt-4o-mini   # tuomarina toimiva malli
    systemPrompt: "Olet tiukka arvioija. Anna vastauksen laadulle asteikolla 1-5 pelkkä numero."
```

tai välitä `"judge": true` `run_eval`-kutsun `arguments`-kenttään (ks.
esimerkki yllä) - tämä ohittaa `config.yaml`:n asetuksen vain kyseiselle
ajolle. Tuloksena `EvalCaseResult.judgeScore`/`EvalModelSummary.avgJudgeScore`
täyttyvät `null`:n sijaan. Huomaa hintavaikutus: judge tekee yhden
ylimääräisen mallikutsun jokaista prompt-tapausta kohden, joten se sekä
maksaa että kestää suunnilleen kaksinkertaisesti verrattuna
avainsanatarkistukseen.

**Valitse `eval.judge.model` eri malliksi kuin arvioitavat mallit.** Malli
suosii tyypillisesti omaa vastaustyyliään (esim. omaa tapaansa jäsentää
vastaus tai muotoilla lauseet), jolloin sama malli tuomarina antaisi
korkeampia pisteitä omaa tyyliään muistuttaville vastauksille - tämä vinouttaa
vertailua juuri sitä mallia suosivaksi. Käytä siis tuomarina mallia, joka ei
ole yksikään `run_eval`-kutsun `models`-listalla olevista.

## Esimerkki: mitattu vertailu

Alla yhden oikean `run_eval`-ajon tulokset (`examples/eval-prompts.fi.json`,
20 promptia, judge pois päältä), joissa verrattiin kahta OpenRouterin kautta
LiteLLM-proxyn taakse ajettua mallia: `deepseek-v4.1-flash` vs.
`qwen3-coder`.

**Kokonaisuus:**

| Malli               | Läpäisy       | Viive ka. | Hinta ka./kutsu |
|---------------------|---------------|-----------|------------------|
| deepseek-v4.1-flash | 83 % (15/18, 2 aikakatkaisua) | 14 802 ms | 0,000744 USD |
| qwen3-coder         | 85 % (17/20)  | 9 887 ms  | 0,000466 USD |

**Tehtävätyypeittäin** (läpäisty/n, viive ka., hinta ka. USD/kutsu):

| Tehtävätyyppi | deepseek-v4.1-flash | qwen3-coder |
|---|---|---|
| yleinen | 5/5, 2 190 ms, 0,000119 | 5/5, 5 600 ms, 0,000159 |
| koodaus | 5/5, 4 025 ms, 0,000278 | 5/5, 3 742 ms, 0,000188 |
| kirjoitus | 3/5, 7 841 ms, 0,000416 | 3/5, 1 567 ms, 0,000121 |
| pilkkominen | 2/5 (+2 aikakatkaisua), 45 151 ms, 0,001867 | 4/5, 28 640 ms, 0,001395 |

**Tulkinta:** kokonaisläpäisy on lähellä molemmilla malleilla, mutta
`qwen3-coder` on sekä nopeampi että halvempi joka tehtävätyypissä tässä
ajossa, ja se selvisi pilkkomistehtävistä ilman aikakatkaisuja.
`deepseek-v4.1-flash`:n kaksi aikakatkaisua osuivat molemmat
pilkkomistehtäviin (60 s oletusaikakatkaisulla) - ks.
[Tehtävätyyppikohtainen aikakatkaisu](#tehtävätyyppikohtainen-aikakatkaisu-timeoutms),
joka on juuri tätä varten.

**Rajoitukset - lue nämä luvut varoen:**

- **Pieni otos**: vain 5 promptia per tehtävätyyppi (20 yhteensä). Yksikin
  tapaus muuttaa prosenttilukua 20 %-yksiköllä; tuloksia ei pidä yleistää
  suoraan muihin promptteihin tai käyttötapauksiin.
- **Avainsanatarkistus arvioi kirjoitustehtäviä huonosti**: `expectedContains`
  hylkää muuten hyvän vastauksen, jos se ei sisällä täsmälleen odotettua
  sanaa - kirjoitus/tiivistys-sarakkeen 3/5-luvut molemmilla malleilla
  todennäköisesti aliarvioivat todellisen laadun. Ks. [Judge-tila](#eval-ajo-run_eval)
  luotettavampaa vaihtoehtoa varten.
- **Deepseekin aikakatkaisut** nostivat sen keskiviivettä ja hintaa
  pilkkomis-sarakkeessa merkittävästi (60 s per aikakatkaisu lasketaan
  mukaan viiveeseen) - ilman niitä keskiviive olisi ollut matalampi.
- **Tulokset ovat yhdestä ajosta** (run `be440639-9aa7-4330-8c66-8cb2ed27b9ef`)
  tiettynä ajankohtana ja riippuvat mallien senhetkisistä versioista sekä
  OpenRouterin kuormasta/saatavuudesta - ne eivät ole pysyvä benchmark-tulos,
  vaan esimerkki siitä, miten `run_eval`:n tulosraporttia luetaan. Aja oma
  eval omilla prompteillasi ennen tuotantopäätöksiä.

## Claude Desktop / Cursor -asetus

`claude_desktop_config.json` (tai vastaava Cursorin MCP-asetustiedosto),
stdio-siirtotavalla:

```json
{
  "mcpServers": {
    "model-router": {
      "command": "node",
      "args": ["/polku/mcp-model-router/dist/index.js"],
      "env": {
        "CONFIG_PATH": "/polku/mcp-model-router/config.yaml",
        "LLM_BASE_URL": "http://localhost:4000",
        "LLM_API_KEY": "sk-...",
        "DB_PATH": "/polku/mcp-model-router/data/mcp-model-router.sqlite"
      }
    }
  }
}
```

Jos palvelin pyörii jo HTTP-tilassa (esim. omassa LXC-kontissa), monet
MCP-klientit tukevat myös suoraa streamable HTTP -yhteyttä osoitteeseen
`http://<tailscale-host>:3100/mcp` ilman `command`-käynnistystä - katso oman
klienttisi dokumentaatio.

## Ajaminen Proxmox-LXC:ssä

Ei Dockeria - palvelin ajetaan suoraan Node-prosessina systemd-yksikkönä.

1. Luo (tai käytä) Debian/Ubuntu-pohjainen LXC-kontti, asenna Node.js 22 tai 24.
2. Kloonaa repo `/opt/mcp-model-router`-hakemistoon ja aja:
   ```bash
   cd /opt/mcp-model-router
   npm ci
   npm run build
   cp config.example.yaml config.yaml   # muokkaa
   ```
3. Luo palvelulle oma käyttäjä ja data-hakemisto:
   ```bash
   useradd --system --home /opt/mcp-model-router --shell /usr/sbin/nologin mcp-model-router
   mkdir -p /opt/mcp-model-router/data
   chown -R mcp-model-router:mcp-model-router /opt/mcp-model-router
   ```
4. Kopioi ympäristötiedosto ja täytä arvot (ei versionhallintaan):
   ```bash
   cp systemd/mcp-model-router.env.example /opt/mcp-model-router/mcp-model-router.env
   chmod 600 /opt/mcp-model-router/mcp-model-router.env
   ```
5. Asenna systemd-yksikkö, ks. valmis esimerkki
   [`systemd/mcp-model-router.service`](./systemd/mcp-model-router.service):
   ```bash
   cp systemd/mcp-model-router.service /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now mcp-model-router
   systemctl status mcp-model-router
   ```

Yksikkö kuuntelee `MCP_HTTP_HOST`-osoitteessa (aseta env-tiedostoon kontin
Tailscale-osoite `tailscale ip -4`), jolloin muut LXC-kontit tavoittavat
palvelimen Tailscale-verkon yli. Env-tiedostossa täytyy olla `MCP_AUTH_TOKEN`
(väh. 32 merkkiä), muuten palvelin ei käynnisty, ja clientien täytyy lähettää se
Bearer-otsakkeessa. Aseta myös `EVAL_DIR`, jos käytät `run_eval`ia. Pääsy
rajataan lisäksi Tailscale ACL:eillä.

## Tietoturva

Periaate: rajat ovat koodissa ja ne epäonnistuvat suljetusti (virhetilassa
kielletään). Mitään alla olevista rajoista ei voi löysätä ympäristömuuttujalla,
`config.yaml`:lla eikä työkalun parametrilla.

**Bearer-tunnistus (`MCP_AUTH_TOKEN`).** HTTP-tilassa `/mcp` (POST, GET,
DELETE) vaatii otsakkeen `Authorization: Bearer <token>`.

- Palvelin **ei käynnisty** HTTP-tilassa, jos `MCP_AUTH_TOKEN` puuttuu tai on
  alle 32 merkkiä. Luo token esim. `openssl rand -hex 32`.
- Puuttuva otsake, väärä skeema ja väärä token antavat täsmälleen saman
  401-vastauksen, joka ei paljasta syytä. Vertailu on vakioaikainen
  (`crypto.timingSafeEqual` SHA-256-tiivisteillä, joten eri pituiset syötteet
  eivät vuoda tietoa).
- Tokenia ei kirjoiteta lokiin eikä virheilmoituksiin. Pidä se
  ympäristötiedostossa (`chmod 600`), ei versionhallinnassa.
- Oletus-bind on `127.0.0.1`. `/healthz` on avoin eikä palauta muuta kuin
  `{"status":"ok"}`.
- Stdio-tila ei käytä tokenia (prosessi on paikallinen).
- Token ei korvaa verkkotason rajausta: käytä edelleen Tailscale ACL:iä äläkä
  kuuntele `0.0.0.0`:ssa.
- **Bearer-token kulkee HTTP:ssä salaamattomana.** Käytä HTTP-tilaa vain
  Tailscalen (WireGuard) tai localhostin kautta, ei koskaan avoimen verkon yli.
- **Tunnettu rajoitus:** MCP SDK:n Express-sovellus jäsentää JSON-rungon ennen
  Bearer-tarkistusta, joten tunnistamaton pyyntö voi kuluttaa hieman
  jäsentimen aikaa. Rungon koko on rajattu, ja palvelin kuuntelee oletuksena
  vain `127.0.0.1`:ssä. Älä altista palvelinta julkiseen verkkoon.

**`run_eval`-tiedostopolut (`EVAL_DIR`).** `run_eval` lukee prompt-tiedostoja
vain yhdestä hakemistosta.

- Jos `EVAL_DIR` ei ole asetettu, `run_eval` kieltäytyy kaikista poluista.
- Polku ratkaistaan `realpath`illa ja verrataan hakemistoon: `../`-polut,
  hakemiston ulkopuoliset absoluuttiset polut ja ulos johtavat symlinkit
  hylätään. Suhteelliset polut tulkitaan `EVAL_DIR`:in suhteen.
- Vain `.json`-päätteet (kirjainkoolla ei väliä), tarkistus `realpath`in jälkeen.
- Hylkäysviesti on aina sama eikä sisällä polkua.

**Kustannuskatot** (vakiot tiedostossa [`src/lib/limits.ts`](./src/lib/limits.ts),
tarkistus `callChatCompletion`issa, joten ne kattavat `route_and_complete`n,
`run_eval`in ja judgen):

| Raja | Arvo | Käytös |
|------|------|--------|
| `max_tokens` per kutsu | 4096 | Suurempi pyydetty `maxTokens` **hylätään virheellä** (ei pienennetä hiljaa). Jos arvoa ei anneta, rajapinnalle lähetetään 4096. |
| Mallikutsuja per `run_eval` | 200 | Lasketaan mallit × promptit (× 2, jos judge on päällä). Ylitys hylätään ennen ensimmäistä kutsua. |
| Päiväbudjetti | 1 000 000 tokenia / päivä | Päivä on `Europe/Helsinki`-ajassa. |

Päiväbudjetti toimii varausperiaatteella: ennen jokaista kutsua varataan
syötteen arvio + `max_tokens` SQLiten `token_budget`-taulusta
`BEGIN IMMEDIATE` -transaktiossa (tarkistus ja varaus ovat jakamaton
kokonaisuus, joten rinnakkaiset kutsut eivät ohita rajaa). Kutsun jälkeen
varaus korjataan vastauksen `usage`-arvoon. Jos `usage` puuttuu, varaus jää
voimaan. Epäonnistunut ja tyhjä vastaus kuluttavat budjettia. Budjetin ylitys
ei käynnistä varamallia. Rajan muuttaminen vaatii koodimuutoksen.

**Tyhjät vastaukset.** Tyhjä, vain välilyöntejä sisältävä tai puuttuva
vastaus on virhe `vastaus_tyhja`, ei onnistuminen. `run_eval`issa se on
epäonnistunut tapaus (`passed: false`, `error` alkaa `vastaus_tyhja`) ja
lasketaan läpäisyprosentin nimittäjään.

## Kehitys

```bash
npm run dev          # tsx, stdio-siirtotapa suoraan lähdekoodista
npm run typecheck    # tsc --noEmit
npm test             # vitest, HTTP-kutsut mockattu undicilla
```

CI ajaa lisäksi [mcp-doctorin](https://github.com/tonyweckstrom1987/mcp-doctor) (MCP-kättely, työkalujen skeemat ja verkoton savuajo `test/mcp-doctor/smoke.json`). Paikallisesti:

```bash
npm run build
CONFIG_PATH=$PWD/config.example.yaml npx @tonyweckstrom/mcp-doctor --env CONFIG_PATH --strict --smoke test/mcp-doctor/smoke.json -- node dist/index.js
```

## Tunnetut rajoitukset

- HTTP-tilan tunnistus on yksi jaettu Bearer-token (ei käyttäjä- tai
  agenttikohtaisia tunnuksia, ei tokenin kierrätystä ajon aikana), eikä
  palvelin itse salaa liikennettä (HTTP ei salaa tokenia), joten liikenne
  saa kulkea vain `127.0.0.1`:n tai Tailscalen kautta.
- MCP SDK:n Express-sovellus jäsentää JSON-rungon ennen Bearer-tarkistusta,
  joten tunnistamaton pyyntö ehtii kuluttaa hieman jäsennysaikaa (rungon koko
  on rajattu). Tämä hyväksytään tietoisesti: oman Express-sovelluksen
  kirjoittaminen SDK:n tilalle toisi enemmän omaa koodia ja riskiä kuin
  hyötyä, ja palvelin kuuntelee oletuksena vain `127.0.0.1`:ssä (tai
  Tailscalessa).
- Päiväbudjetti on tokenipohjainen ja kattaa vain tämän palvelimen kautta
  tehdyt kutsut; se ei tiedä LiteLLM:n/OpenRouterin muista asiakkaista tulevaa
  kulutusta (`get_usage` näyttää sen).
- Syötteen tokenimäärä on arvio (merkkimäärä / 3); varaus korjataan
  toteutuneeseen `usage`-arvoon vasta kutsun jälkeen.
- Ei automaattista mallilistan hakua LiteLLM:n `/models`-rajapinnasta -
  `list_models` lukee vain `config.yaml`:n.
- Eval-hinta-arvio perustuu `config.yaml`:n `eval.pricing`-hinnastoon, ei
  automaattiseen hintojen hakuun OpenRouterista.
- `get_usage` vaatii, että LiteLLM on käynnistetty tietokannan (Postgres)
  kanssa ja että `USAGE_API_KEY` on LiteLLM:n **pääavain** (`LITELLM_MASTER_KEY`),
  koska `/user/info` on hallintarajapinta. Ilman tietokantaa LiteLLM palauttaa
  `"Database not connected"` (HTTP 500), ja `get_usage` välittää tämän virheen
  sellaisenaan kutsujalle. Pelkkä OpenRouter-käyttö (`usage.provider: openrouter`)
  ei vaadi tietokantaa.
- `tasks`-lohkon ja `run_eval`:n mallitunnisteet ovat LiteLLM:n
  `model_name`-aliaksia (LiteLLM-konfiguraatiossa/proxy-mallilistassa
  määriteltyjä nimiä), eivät suoraan OpenRouterin tai muun taustapalvelun
  omia mallitunnisteita - ks. [Mallitunnisteet: LiteLLM vs. suora
  OpenRouter](#mallitunnisteet-litellm-vs-suora-openrouter).
