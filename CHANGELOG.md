# Muutosloki

Kaikki merkittävät muutokset kirjataan tähän tiedostoon. Muoto noudattaa
[Keep a Changelog](https://keepachangelog.com/fi/1.1.0/) -käytäntöä.

## [Unreleased]

### Korjattu
- HTTP-tila: `MCP_HTTP_PORT` jäsennetään tiukasti (kokonaisluku 1–65535). Aiemmin `parseInt` hyväksyi arvon `3100abc` (→ 3100) ja `0`, jolloin palvelin kuunteli käyttöjärjestelmän satunnaisessa portissa ja loki näytti osoitteen `:0`, eikä yksikään asiakas löytänyt palvelua; `abc` kaatui Noden pinojälkeen. Nyt virheellinen arvo pysäyttää käynnistyksen koodilla 1 selkeällä viestillä ennen asetusten latausta ja tietokannan avausta. Tyhjä arvo tarkoittaa oletusporttia 3100.

## [0.1.2] - julkaisupäivä täydennetään

### Lisätty

- README on käännetty kokonaan englanniksi (sisällysluettelon ankkurit päivitetty) (0dcf6be, #51). Korjattu kaksi koodin vastaista väitettä: Bearer-tunnistus ajetaan ennen JSON-jäsennystä (README väitti päinvastaista), ja mitatun vertailun tulkinta vastaa nyt taulukkoa (`qwen3-coder` oli yleinen-tehtävätyypissä hitaampi ja kalliimpi, muissa tyypeissä nopeampi ja halvempi).
- README: englanninkielinen osio "Quick start from npm" (asennus, `config.example.yaml`:n kopiointi paketista ja käynnistys `CONFIG_PATH`:lla) (0f1f917, #49).

### Muutettu
- Puuttuvan asetustiedoston virhe on englanniksi, kertoo absoluuttisen polun ja korjauksen eikä tulosta pinojälkeä. Poistumiskoodi on edelleen 1 (0f1f917, #49).

### Korjattu
- `provider.timeoutMs` ja `tasks.<tyyppi>.timeoutMs` hyväksyivät minkä tahansa positiivisen kokonaisluvun. Yli 2 147 483 647 ms:n arvolla Noden `setTimeout` asettaa ajastimen 1 ms:iin, joten jokainen mallikutsu aikakatkaistiin heti ja varasi silti päiväbudjettia. Nyt asetuksen lataus hylkää arvon, ja `callChatCompletion` hylkää virheellisen aikakatkaisun ennen budjettivarausta ja kutsua. (2145a9a, #61).
- Asetustiedoston `${NIMI}`-korvaus lisää ympäristömuuttujan arvon kirjaimellisena. Aiemmin arvo jäsennettiin uudelleen, joten esim. API-avain tai salasana, jossa on `${...}`, muuttui hiljaa, ja arvo `a${X}` muuttujassa `X` jumitti käynnistyksen ikuiseen silmukkaan. (2145a9a, #61).
- `run_eval` hylkää saman mallin listalla kahdesti ennen tiedoston lukua ja kutsuja (aiemmin jokainen kutsu tehtiin kahdesti ja yhteenvedossa oli kaksi samaa riviä). Prompt-tiedosto, jossa sama `id` toistuu, hylätään validoinnissa, koska yhteenvedot tunnistavat tapaukset id:n perusteella. (2145a9a, #61).
- HTTP-tila: Bearer-tunnistus ajetaan ennen JSON-jäsennystä. Tunnistamattoman pyynnön bodya ei enää lueta, joten virheellinen JSON tai liian suuri body antaa 401:n eikä Expressin HTML-virhesivua pinojälkineen. Tunnistetun pyynnön jäsennysvirhe palauttaa JSON-RPC-virheen `-32700 Parse error` (katselmointi 28.10., löydös 9). DNS rebinding -suoja (Host-otsakkeen tarkistus) toimii kuten ennen. (5dd6e7d, #42).
- HTTP-tila: pyyntökohtainen `McpServer` ja transport suljetaan nyt myös, kun `connect` tai `handleRequest` heittää tai yhteys sulkeutuu kesken käsittelyn; aiemmin ne jäivät auki (löydös 8). (5dd6e7d, #42).
- `run_eval`: LLM-tuomarin pisteiden poiminta ei enää lue ensimmäistä numeroa 1-5 mistä tahansa tekstistä. Vastaukset kuten "10/10" tai "vuonna 2024" eivät enää anna pisteitä 1 tai 2; epäselvä vastaus jättää pisteen pois sen sijaan, että vääristäisi keskiarvoa (katselmointi 28.10., löydös 10). (d2e1d2b, #41).
- `run_eval`: tuomarikutsun virheet (myös `LimitExceededError`) eivät enää katoa hiljaa. Tapauskohtainen `judgeError` ja mallikohtainen `judgeErrorCount` kertovat, miksi piste puuttuu. (d2e1d2b, #41).
- `run_eval`: tuomarikutsu varaa oletuksena 64 tokenia 4096:n sijaan (uusi valinnainen `eval.judge.maxTokens`, enintään kutsukohtainen katto 4096). (d2e1d2b, #41).
- `run_eval` sallii vain `tasks`-osion mallit (`model`, `fallbackModel`) ja valinnaisen `eval.allowedModels`-listan. Aiemmin `models` hyväksyi minkä tahansa tunnisteen, jolloin tokenin haltija pystyi ohjaamaan kutsut proxyn kalleimpaan malliin. Tarkistus tehdään ennen tiedostojen lukua, kirjauksia ja kutsuja (katselmointi 28.10., löydös 3; 97ab7ab, #39).
- `get_usage`: kulutusrajapinnan kutsulla on nyt aikakatkaisu (oletus 15 s, asetus `usage.timeoutMs`). Aiemmin roikkuva kutsu odotti rajattomasti ja piti HTTP-tilassa oman palvelininstanssinsa hengissä (katselmointi 28.10., löydös 5; bb139a7, #38; 27eebf9, #40 on samansisältöinen kaksoiskommitti).
- Kirjausvirhe (esim. `SQLITE_READONLY`) ei enää laukaise varamallia eikä kaada `run_evalia`. Virhe kirjataan stderriin ja mallikutsun tulos säilyy (katselmointi 28.10., löydökset 1 ja 4; 6d2befa, #37).
- HTTP-tila: `listen`-virhe (esim. `EADDRINUSE`) tunnistetaan, kirjataan koodina ja palvelu päättyy koodilla 1. Aiemmin Express 5:n virheellinen takaisinkutsu tulkittiin onnistuneeksi käynnistykseksi (b616de3, #52).
- `route_and_complete` hyväksyy vain asetustiedoston omat tehtävätyypit; periytyneet avaimet (`constructor`, `toString`, `__proto__`) hylätään (b616de3, #52).

### Muuta
- CI: `mcp-doctor`-terveystarkastus ja verkoton savuajo; esimerkkiasetuksen palvelinversio korjattu vastaamaan pakettia (e2aed26, #36).
- Automerge päivitetty versioon 2: yhdistää vain tarkastajan hyväksymät, rajaamattomat PR:t (32a6eee, #48). Dependabotin automerge koskee vain patch- ja minor-päivityksiä (ef8dfca, #32).
- Testit: automerge-testit (a4347cd, #33), budjettitestit (62a919b, #43) ja tyhjä `test/__init__.py`, jotta repon omat testit voittavat samannimisen testipaketin (584807d, #53).
- README-päivitykset (27e6a8e, #35; b3d0f67, #47).
- Riippuvuudet: express ja `@types/express` (e359ea4, #16), `@types/node` 26.6.5 ja 26.6.6 (61c3eb4, #10; 1a587ef, #45), vitest 5.0.5 (49b5107, #25), js-yaml 5.5.0 (87d4f26, #27), vite 8.3.5 (ed5edd0, #34), MCP SDK 1.32.2 (27081f7, #46) ja evalkit-action (9ac4b39, #24).
- Palvelimen oletusversio (`server.version`) ja `config.example.yaml` nostettu versioon 0.1.2.
