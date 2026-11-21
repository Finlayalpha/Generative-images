# Free Parking Finder (UK)

A phone app that suggests **free, legal** places to park near where you're going, for the length of your stay,
filtered to spaces your vehicle fits. It suggests places; it does not say whether a space is empty.

You enter:
- where you're going
- when you'll arrive and how long you'll stay
- your vehicle's length, width and height (remembered on the phone)

You get a list of kerbs and car parks within walking distance, nearest first, each labelled by how well its rules
are known.

```
npm install
npm run dev          # http://localhost:5173        (live OpenStreetMap data)
                     # http://localhost:5173/?demo  (synthetic demo town, works offline)
npm test             # unit tests
npm run build        # static PWA in dist/
```

## Where the rules come from

See **[docs/UK_DATA_STRATEGY.md](docs/UK_DATA_STRATEGY.md)** for the full plan. In short, every street gets:

1. **UK national rules from the road layout** (every street in the UK). No parking:
   - within 10 m of a junction
   - on crossing zig-zags, at bus stops or taxi ranks
   - across driveways and dropped kerbs, or near level crossings
   - in cycle or bus lanes, by double white lines, on roundabouts or in tunnels
   - where it would leave less than 3 m for traffic

   These are cut out of the kerb (`src/uk/`).
2. **Local rules mapped in OpenStreetMap** (`parking:<side>:*` tags), where they exist: fees, time windows, max
   stay, residents' zones, clearways (`src/rules/`).
3. **Road markings from aerial photography**, where a survey has been processed: yellow lines, zig-zags, red
   routes and bus lanes remove kerbs, and kerbs with no lines are marked as checked. Spec:
   [docs/KERB_MARKINGS_FORMAT.md](docs/KERB_MARKINGS_FORMAT.md). The app side is built; the detector needs
   licensed imagery.
4. **Council open data**, fetched live where a council publishes it (**Camden** so far):
   - every bay with its type, hours, max stay and space size
   - controlled parking zone hours (other kerbs count as single yellow lines during them)
   - live bay suspensions

   Outside their hours, pay and permit bays become free (`src/councils/`).
5. **Next:** more councils, TfL red routes, the DfT's digital TRO service, and user reports.

Each result is labelled **Council data**, **Rules mapped**, **Partly mapped**, **Lines checked** (no yellow lines in the aerial
photo, with its date) or **Unsurveyed** (national rules only: check for yellow lines and signs). Unsurveyed streets
can be hidden.

## Vehicle size

Body length, width and height in metres, with presets (city car to long-wheelbase high-roof van). Places are
hidden when the vehicle won't fit, and flagged "Check size" when it's borderline (`src/vehicle.ts`):

| Check | Rule |
|---|---|
| Street height, width and length limits | `maxheight` / `maxwidth` / `maxlength` on the street (e.g. low bridges) |
| Car park clearance | `maxheight` on the car park. Multi-storey and underground car parks with no mapped limit are assumed to be 1.9–2.1 m |
| Perpendicular and diagonal bays | UK standard 2.4 × 4.8 m: overhanging the markings is a contravention |
| Marked parallel bays | Usually about 2.0 × 6.0 m |
| Kerb gap length | At least vehicle length + 1 m, after the national-rule cut-outs |
| Narrow streets | Mapped width − your width − a car opposite < 3 m means obstruction (HC 242) |

## Ranking

Results are listed nearest first: straight-line distance from the destination to the nearest point of each kerb
block (≤ 100 m). The list also shows the direction ("40 m NE") and an estimated walk (× 1.3 at 80 m/min). "Best-known
rules first" sorts by tier, then distance.

## Code map

| Path | What |
|---|---|
| `src/rules/engine.ts` | Evaluates OSM parking tags for a stay: free / paid / permit / restricted / max stay |
| `src/rules/conditional.ts`, `legacy.ts`, `duration.ts` | Time conditions, the old `parking:lane` scheme, durations |
| `src/uk/zones.ts` | National-rule cut-outs: junctions, crossings, bus stops, driveways, … |
| `src/uk/streets.ts` | Which unmapped streets can be suggested at all |
| `src/uk/kerbs.ts` | Builds kerb pieces: mapped or inferred rules, cut-outs, aerial markings, vehicle fit |
| `src/uk/markings.ts` | What each aerial-photo marking means for a kerb |
| `src/uk/council.ts` | Puts council bays on kerbs; bay and controlled-zone rules |
| `src/councils/` | Council adapters (Camden), council times → opening_hours |
| `test/fixtures/` | Real Camden data snapshots (OGL v3.0) used by the tests |
| `src/data/markings.ts` | Loads and validates `kerb-markings/1` files (from `VITE_MARKINGS_URL`) |
| `src/vehicle.ts` | Vehicle presets and size checks |
| `src/search/rank.ts` | Blocks, distance, tiers, filtering and sorting |
| `src/search/geocode.ts` | UK address and place search (Nominatim, `countrycodes=gb`) |
| `src/data/overpass.ts` | Loads roads, rule-relevant points and car parks around the destination |
| `src/main.ts`, `index.html`, `src/style.css` | Phone UI: bottom sheet, results list, map |
| `public/` | PWA manifest, icons, service worker |

## The app

It's built as a phone-first progressive web app: it can be added to the home screen, opens full screen, and caches
the app shell for poor signal. The same code can be wrapped with Capacitor to publish to the App Store and Google
Play when we need native features such as background location or CarPlay / Android Auto.

Before production:
- Replace the public Overpass, Nominatim and OSM tile servers with our own or paid services. Their usage policies
  don't allow app-scale traffic.
- Serve pre-merged rule tiles from a backend (see the strategy doc).
- Evaluate times in UK local time, and load bank holidays from the gov.uk bank-holidays feed. Today `PH` rules
  are treated as if no day is a bank holiday.

## Data and licensing

Map data © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright). Every popup links to the
OSM object so users can correct it. The app is a guide only: signs and road markings always take priority.
