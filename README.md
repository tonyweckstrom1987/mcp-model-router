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

Vaatii Node.js 20 tai 22.

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
| `MCP_HTTP_PORT`     | HTTP-siirtotavan portti                                         | `3000`                     |
| `MCP_ALLOWED_HOSTS` | Pilkulla eroteltu lista sallittuja Host-otsikoita (DNS-rebinding-suojaus) | (ei asetettu)      |

### Ajaminen

```bash
# stdio (esim. Claude Desktop / Cursor)
npm start

# streamable HTTP (muut kontit Tailscale-verkossa)
MCP_TRANSPORT=http MCP_HTTP_HOST=0.0.0.0 MCP_HTTP_PORT=3000 npm start
```

HTTP-tilassa palvelin vastaa osoitteessa `http://<host>:<port>/mcp` ja
tarjoaa lisäksi `GET /healthz` -terveystarkastuksen.

### Nopea kokeilu

Kolmella komennolla ensimmäinen `route_and_complete`-kutsu toimimaan
paikallista LiteLLM-proxyä vasten (oleta, että LiteLLM pyörii jo
osoitteessa `http://localhost:4000` ja siinä on ainakin `general`-tehtävän
malli konfiguroitu):

```bash
npm install && npm run build
cp config.example.yaml config.yaml

echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"route_and_complete","arguments":{"taskType":"general","prompt":"Sano hei suomeksi"}}}' \
  | LLM_BASE_URL=http://localhost:4000 LLM_API_KEY=sk-... node dist/index.js
```

Kolmas komento käynnistää palvelimen stdio-siirtotavalla, syöttää sille
yhden `tools/call`-pyynnön stdinistä ja tulostaa vastauksen. HTTP-tilassa
vastaava kutsu tehdään `curl`illa `/mcp`-osoitteeseen (ks. [Ajaminen](#ajaminen)).

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
`http://<tailscale-host>:3000/mcp` ilman `command`-käynnistystä - katso oman
klienttisi dokumentaatio.

## Ajaminen Proxmox-LXC:ssä

Ei Dockeria - palvelin ajetaan suoraan Node-prosessina systemd-yksikkönä.

1. Luo (tai käytä) Debian/Ubuntu-pohjainen LXC-kontti, asenna Node.js 20/22.
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

## Mitä ei (vielä) ole

- Ei omaa autentikointia HTTP-siirtotavalle (luotetaan verkkotason
  rajaukseen, esim. Tailscale).
- Ei automaattista mallilistan hakua LiteLLM:n `/models`-rajapinnasta -
  `list_models` lukee vain `config.yaml`:n.
- Eval-hinta-arvio perustuu `config.yaml`:n `eval.pricing`-hinnastoon, ei
  automaattiseen hintojen hakuun OpenRouterista.
