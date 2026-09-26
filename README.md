# mcp-model-router

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

Neljällä komennolla ensimmäinen `route_and_complete`-kutsu HTTP-tilassa
(oleta, että LiteLLM pyörii jo osoitteessa `http://localhost:4000` ja siinä
on ainakin `general`-tehtävän malli konfiguroitu):

```bash
npm install && npm run build
cp config.example.yaml config.yaml   # muokkaa tarpeen mukaan
LLM_BASE_URL=http://localhost:4000 LLM_API_KEY=sk-... MCP_TRANSPORT=http MCP_HTTP_PORT=3100 npm start &
curl -s -X POST http://127.0.0.1:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"route_and_complete","arguments":{"taskType":"general","prompt":"Sano hei suomeksi"}}}'
```

Neljäs komento tekee `tools/call`-pyynnön palvelimen `/mcp`-päätepisteeseen ja
tulostaa vastauksen (streamable HTTP -tapahtumavirtana). Tarkemmat
ympäristömuuttujat, `stdio`-siirtotapa ja `GET /healthz` -terveystarkastus:
ks. [Asennus](#asennus) ja [Ajaminen](#ajaminen).

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
  palvelinta yhtäaikaisesti. Palvelin ei toteuta omaa kirjautumista - pääsy
  rajataan verkkotasolla (Tailscale ACL:t).
- **Konfiguraatio**: `config.yaml` (ympäristömuuttujaviittauksin, ei
  salaisuuksia tiedostossa) + varsinaiset arvot ympäristömuuttujista.
- **Kontekstin kokoa ei rajoiteta keinotekoisesti** - `maxTokens` on
  valinnainen parametri per kutsu, ei kovakoodattu yläraja.

## Asennus

Vaatii Node.js 20, 22 tai 24.

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
| `MCP_ALLOWED_HOSTS` | Pilkulla eroteltu lista sallittuja Host-otsikoita (DNS-rebinding-suojaus) | (ei asetettu)      |

### Ajaminen

```bash
# stdio (esim. Claude Desktop / Cursor)
npm start

# streamable HTTP (muut kontit Tailscale-verkossa)
MCP_TRANSPORT=http MCP_HTTP_HOST=0.0.0.0 MCP_HTTP_PORT=3100 npm start
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

eval:
  judge:
    enabled: false
    model: openrouter/openai/gpt-4o-mini
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

### Eval-ajo (`run_eval`)

`run_eval` on MCP-työkalu, ei erillinen CLI-komento - se kutsutaan samalla
tavalla kuin muutkin työkalut (`tools/call`, ks. [Nopea
kokeilu](#nopea-kokeilu)). Esimerkki HTTP-tilassa, kahdella mallilla ja
`eval-prompts.fi.json`-sarjalla:

```bash
curl -s -X POST http://127.0.0.1:3100/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{
      "name":"run_eval",
      "arguments":{
        "promptSetPath":"examples/eval-prompts.fi.json",
        "models":["openrouter/deepseek/deepseek-v4.1-flash","openrouter/qwen/qwen3-flash"],
        "judge": false
      }
    }
  }'
```

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
- Pitkä eval kestää useita minuutteja: esim. 2 mallia × 20 promptia = 40
  peräkkäistä mallikutsua, ja jokainen kutsu voi kestää useita sekunteja
  (tai `provider.timeoutMs`/tehtävätyypin oman `timeoutMs`:n verran, jos
  malli jumiutuu) - ks. [Esimerkki: mitattu
  vertailu](#esimerkki-mitattu-vertailu). `judge: true` lähes tuplaa ajoajan,
  koska jokainen vastaus arvioidaan vielä erikseen.

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

1. Luo (tai käytä) Debian/Ubuntu-pohjainen LXC-kontti, asenna Node.js 20, 22 tai 24.
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
palvelimen Tailscale-verkon yli ilman erillistä autentikointia - pääsy
rajataan Tailscale ACL:eillä.

## Kehitys

```bash
npm run dev          # tsx, stdio-siirtotapa suoraan lähdekoodista
npm run typecheck    # tsc --noEmit
npm test             # vitest, HTTP-kutsut mockattu undicilla
```

## Tunnetut rajoitukset

- Ei omaa autentikointia HTTP-siirtotavalle (luotetaan verkkotason
  rajaukseen, esim. Tailscale).
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
