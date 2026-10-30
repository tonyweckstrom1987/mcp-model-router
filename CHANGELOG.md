# Muutosloki

Kaikki merkittävät muutokset kirjataan tähän tiedostoon. Muoto noudattaa
[Keep a Changelog](https://keepachangelog.com/fi/1.1.0/) -käytäntöä.

## [Unreleased]

### Korjattu
- HTTP-tila: Bearer-tunnistus ajetaan ennen JSON-jäsennystä. Tunnistamattoman pyynnön bodya ei enää lueta, joten virheellinen JSON tai liian suuri body antaa 401:n eikä Expressin HTML-virhesivua pinojälkineen. Tunnistetun pyynnön jäsennysvirhe palauttaa JSON-RPC-virheen `-32700 Parse error` (katselmointi 28.10., löydös 9). DNS rebinding -suoja (Host-otsakkeen tarkistus) toimii kuten ennen.
- HTTP-tila: pyyntökohtainen `McpServer` ja transport suljetaan nyt myös, kun `connect` tai `handleRequest` heittää tai yhteys sulkeutuu kesken käsittelyn; aiemmin ne jäivät auki (löydös 8).
- `run_eval`: LLM-tuomarin pisteiden poiminta ei enää lue ensimmäistä numeroa 1-5 mistä tahansa tekstistä. Vastaukset kuten "10/10" tai "vuonna 2024" eivät enää anna pisteitä 1 tai 2; epäselvä vastaus jättää pisteen pois sen sijaan, että vääristäisi keskiarvoa (katselmointi 28.10., löydös 10).
- `run_eval`: tuomarikutsun virheet (myös `LimitExceededError`) eivät enää katoa hiljaa. Tapauskohtainen `judgeError` ja mallikohtainen `judgeErrorCount` kertovat, miksi piste puuttuu.
- `run_eval`: tuomarikutsu varaa oletuksena 64 tokenia 4096:n sijaan (uusi valinnainen `eval.judge.maxTokens`, enintään kutsukohtainen katto 4096).
