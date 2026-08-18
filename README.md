# RouteWatch v2 - met aankoopadvies op netwerkwinst

Geen server, geen database, geen abonnement. GitHub doet het werk en host het
dashboard. Uploaden, één knop, klaar.

## Nieuw in v2: het aankoopadvies

Prijzen vergelijken doet **FSAddonCompare** al, gratis en beter dan ik het kan:
9.000+ MSFS-add-ons over Aerosoft, Contrail, Flightsim.to, iniBuilds, Just
Flight, Orbx, simMarket en de Marketplace, met prijshistorie, sale-alerts, een
wishlist en een browserextensie. Acht winkels zelf scrapen is acht fragiele
parsers en ToS-risico. Dat bouw ik niet na.

Wat FSAddonCompare **niet** weet, is welke luchthaven jóuw netwerk het meest
oplevert. Dat meet RouteWatch nu wel.

Zet in `config/collection.json` een veld op `"candidate": true`. Het doet dan
mee in het ophalen, maar niet in je hoofdmatrix. De app rekent uit:

- hoeveel **nieuwe bediende paren** die aankoop oplevert
- hoeveel daarvan een **MATCH** met jouw vloot hebben
- hoeveel **simbaar** zijn binnen bereik, rol en de narrowbody-regel
- hoeveel **vrachtparen** erbij komen
- met welke van je eigen velden het precies verbindt

Alles gemeten aan echt waargenomen vluchten, niet geschat. Het tabblad
**Aankoopadvies** zet de kandidaten op die netwerkwinst gesorteerd, met per veld
een directe zoeklink naar FSAddonCompare, simMarket, Contrail, Orbx, iniBuilds,
Aerosoft en Just Flight. RouteWatch zegt *wat*, FSAddonCompare zegt *waar*.

Er zitten tien kandidaten voorgeladen, uit het Deel F-advies:

| # | Veld | Focus | Waarom |
|---|---|---|---|
| 1 | EKCH Kopenhagen | pax | drukste paar vanaf ENGM, ESSA, EFHK én EPWA; plus SAS naar KSFO en QR naar OTHH. Bestaat: SimNord bracht het in aug 2025 uit voor MSFS 2020 en 2024; FlyTampa heeft er ook een |
| 2 | EDDF Frankfurt | pax | top-5 vanaf alle Nordics; LH naar KSFO; vult het gat naast EDDS, EDDK, EDLV |
| 3 | LEMD Madrid | pax | completeert Iberia; IB naar KSFO; QR 18-21 wk; QR Cargo-station |
| 4 | EDDM München | pax | Allegris-A350 naar Kaapstad |
| 5 | LIMC Malpensa | pax+cargo | tweede Italiaans veld; QR Cargo via STN-MXP |
| 6 | EGKK Gatwick | pax | de ontbrekende Londen-schakel voor LFBD, LFBZ, LEZL, LPPR en LGKR |
| 7 | EBLG Luik | cargo | ASL Airlines Belgium met 24 stuks 737-800BCF; ontsluit je hele B7-blok |
| 8 | LFPG Parijs CDG | cargo | ASL France en West Atlantic; grootste FedEx-hub van Europa |
| 9 | EGSS Stansted | cargo | QR Cargo 777F op STN-BRU; direct twee nieuwe 777F-paren met EBBR |
| 10 | EDDP Leipzig | cargo | DHL-hub; EAT Leipzig en Star Air |

Bevalt een kandidaat en heb je hem gekocht? Haal `"candidate": true` weg en het
veld schuift in je collectie. De matrix groeit mee.

## Optioneel: prijzen in het dashboard zelf

Wil je toch prijzen in RouteWatch, zet dan `settings.price_scrape` op `true` en
vul per kandidaat `price_urls` met directe product-URLs:

```json
"price_urls": {
  "simmarket": "https://secure.simmarket.com/....html",
  "contrail":  "https://contrail.co.uk/product/...."
}
```

De app leest dan het schema.org/JSON-LD prijsveld van die pagina's, sorteert op
goedkoopst en stuurt een `PRICE_DROP`-melding bij meer dan 5% daling. Standaard
staat dit **uit**: het is fragiel, winkels stellen eigen voorwaarden, en
FSAddonCompare doet het al.

## Opzetten - vier stappen

1. **Repo maken** op github.com, op **Public** (dan zijn de Actions-minuten
   onbeperkt gratis).
2. **Zip uitpakken en de hele inhoud uploaden** (Add file > Upload files).
3. **Pages aanzetten:** Settings > Pages > branch `main`, map `/docs`.
4. **Eerste run:** Actions > RouteWatch > Run workflow, `backfill_days` = 14.

Daarna elke nacht om 03:30 UTC automatisch. Nul verplichte secrets: de app
werkt uit de doos op OpenSky.

Optionele secrets: `OPENSKY_USER` + `OPENSKY_PASS` (hoger daglimiet),
`RAPIDAPI_KEY` (echte vluchtnummers en geplande tijden; zet dan
`providers.aerodatabox` op `true`), `ROUTEWATCH_WEBHOOK` (Slack of Discord).

## Twee dingen over GitHub-cron

- Vertraging van 5 tot 30 minuten is normaal. Bij een dagelijkse taak irrelevant.
- Na 60 dagen zonder repo-activiteit schakelt GitHub de cron uit. Geen probleem
  hier: de workflow commit zelf elke dag de bijgewerkte data, en dat houdt hem
  levend.

## Inhoud

```
.github/workflows/routewatch.yml   cron + commit
scripts/routewatch.mjs             het hele programma, nul dependencies
config/collection.json             jouw velden, kandidaten, vloot, seizoenen
docs/index.html                    dashboard incl. tabblad Aankoopadvies
data/ledger.json                   het grondboek: hier zit de vergelijking
data/candidates.json               netwerkwinst en prijshistorie per kandidaat
data/events.json                   alle gedetecteerde wijzigingen
data/manual/                       vracht en handmatige rijen
```
