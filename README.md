# Free Parking Finder

Find **free, legal** places to park for the time you plan to stay.

You choose when you'll arrive and how long you'll stay. The app colours each side of every mapped street by
whether parking there is free and legal for that whole stay. If a fee, a clearway or a residents-only period
starts halfway through, the kerb doesn't count as free.

```
npm install
npm run dev          # http://localhost:5173        (live OpenStreetMap data)
                     # http://localhost:5173/?demo  (synthetic data, works offline)
npm test             # rules-engine unit tests
npm run build        # static site in dist/
```

## How it works (v0.1)

```
 map viewport ──► Overpass API (OSM) ──► street ways with parking:* tags
                                          + amenity=parking car parks
                                                   │
 arrive time + stay length ───────────────► rules engine ──► per-kerb status
                                                   │            free / time-limited / paid /
                                                   │            permit / restricted / no parking
                                                   ▼
                                          Leaflet map, left & right kerbs drawn separately
```

* **Regulations come from OpenStreetMap's [street parking scheme](https://wiki.openstreetmap.org/wiki/Street_parking)**
  (`parking:left|right|both`, `…:fee`, `…:maxstay`, `…:access`, `…:restriction`, `…:zone`,
  `…:authentication:disc`, and their `:conditional` forms). The older `parking:lane` / `parking:condition`
  tags are translated to the current scheme (`src/rules/legacy.ts`).
* **Time rules** use the OSM [conditional restriction](https://wiki.openstreetmap.org/wiki/Conditional_restrictions)
  syntax, evaluated with [`opening_hours`](https://github.com/opening-hours/opening_hours.js). Conditions such as
  `stay > 1 hour` are also supported.
* **The stay is sampled every 5 minutes.** Any fee, ban or permit-only period inside the stay disqualifies the
  kerb. Max stay is counted only for the time the limit is actually in force.
* **Every result has a confidence level.** *High*: fee and restrictions are mapped explicitly. *Medium*: there
  is parking but no fee is mapped, so the app assumes free (drawn dashed). *Low*: some condition couldn't be
  evaluated, e.g. `@ (snow)`.

Code map:

| Path | What |
|---|---|
| `src/rules/engine.ts` | Core logic: `assessStreetSide()` and `assessCarPark()` |
| `src/rules/conditional.ts` | Parses and evaluates `value @ (condition); …` |
| `src/rules/legacy.ts` | Translates the old `parking:lane` scheme |
| `src/data/overpass.ts` | Overpass query and response parsing |
| `src/geo/offset.ts` | Offsets a street line to its left or right kerb |
| `src/main.ts` | Map UI |
| `test/engine.test.ts` | Scenarios: pay-and-display, clearways, residents zones, disc zones, legacy tags, car parks |

## About satellite data

Satellites **can't tell you in real time whether a space is empty**, so the app doesn't depend on them for that:

* **Latency and revisit.** The highest-resolution commercial satellites (about 30 cm per pixel) pass over a
  given place a few times a day at best. Ordering, downlinking and processing the image takes hours. A space
  that was empty in a morning image tells you nothing about now.
* **Resolution and occlusion.** 30 cm per pixel is enough to count cars in an open car park. Kerbside spaces
  are often hidden under trees, in building shadow or behind other vehicles, and cloud cover removes whole days.
* **Cost and licensing.** Tasking imagery per city per hour would cost far more than an app like this could
  earn, and redistribution licences usually forbid showing the imagery to users.

Aerial and satellite imagery **is** valuable offline, for building the regulation map itself:

* Detect painted bays, yellow lines, kerb markings and parking lanes, and propose OSM `parking:*` tags where
  none exist. This is the biggest coverage gap.
* Estimate typical occupancy of large surface car parks by time of day, using historical imagery.

Better sources of real-time availability, roughly in order of how practical they are:

1. **City open data:** on-street bay sensors (e.g. Melbourne, some Dutch and Spanish cities), meter and
   payment feeds, and machine-readable kerb rules (CurbLR, CDS, the UK's digital Traffic Regulation Orders
   programme).
2. **Crowdsourcing:** "I'm leaving this space" and "I just parked" events from app users, plus passive signals
   (a phone switches from driving to walking near a kerb).
3. **Probabilistic prediction:** estimate the likelihood of finding a space from time, day, area and past
   events. This is more useful than false precision.

## Roadmap

- [ ] **Coverage:** import official kerb and traffic-order datasets where they exist, and normalise them into
      the same engine input as OSM tags.
- [ ] **Coverage:** use an imagery model to suggest missing kerb tags for review (a MapRoulette-style workflow).
- [ ] **Coverage:** add national default rules, e.g. "no parking within 10 m of a junction" (UK Highway Code
      243, DE StVO §12) and dropped kerbs. These aren't signposted, so OSM rarely maps them.
- [ ] **Rules:** load public holidays per country (pass a location context to `opening_hours`). Right now `PH`
      rules are evaluated as if no day is a public holiday.
- [ ] **Rules:** evaluate in the destination's time zone. Today the browser's local time is used.
- [ ] **Rules:** vehicle profile (EV, motorbike, blue badge, van height and weight).
- [ ] **Availability:** crowdsourced "leaving now" signals and a backend.
- [ ] **Availability:** occupancy prediction.
- [ ] **App:** navigate to the nearest free kerb; save "where I parked" with an expiry reminder.
- [ ] **App:** ship as an installable PWA or native app. Serve map tiles and Overpass from our own or paid
      infrastructure; the public endpoints have usage policies that a production app would break.

## Data and licensing

Map data © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright). Each kerb's popup
links to the OSM object so users can fix wrong or missing rules at the source. The app is a guide only: the
signs on the street always take precedence.
