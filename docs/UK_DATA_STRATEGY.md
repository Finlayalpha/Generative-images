# Getting parking rules for as much of the UK as possible

## The problem

In the UK, local parking rules are set by **Traffic Regulation Orders (TROs)**. These are legal documents made by
each traffic authority: roughly 200 councils, plus TfL and National Highways. Most exist only as PDFs or scanned
maps. Yellow lines, controlled parking zones (CPZs), pay bays, residents' bays and loading bans all come from TROs.

Some rules apply everywhere without any local order. Most are in the Highway Code. That gives us a layered approach:
apply the national rules to every street, then add local rules from whatever source covers the street. Each result
shows which layer its rules came from.

| Tier shown in the app | Meaning |
|---|---|
| **Rules mapped** | Fee and restrictions are recorded explicitly for that kerb |
| **Partly mapped** | Parking is recorded, but not every rule (e.g. no fee recorded), or an aerial photo contradicts it |
| **Lines checked** | No local rules known, but an aerial photo shows no yellow lines (with the photo date) |
| **Unsurveyed** | No local rules known. Only national rules are applied, and the user is told to check for lines and signs |

## Layer 0: national rules from the road layout (built, applies everywhere)

These are derived from OpenStreetMap road geometry, which covers essentially the whole UK
(`src/uk/zones.ts`, `src/uk/streets.ts`).

| Rule | Source | How it's detected | Effect |
|---|---|---|---|
| Not within 10 m of a junction | HC 243 | Nodes where three or more road arms meet | 14 m cut from each kerb (10 m plus half the side road's width). Not applied to mapped bays, since "authorised spaces" are exempt |
| Pedestrian crossing zig-zags | HC 240 (must not) | `highway=crossing` that is zebra or signal-controlled | 18 m cut each side of the crossing |
| Bus stops | HC 243 | `highway=bus_stop` | 15 m cut each side, on the stop's own side of the road only |
| Driveways and dropped kerbs | HC 243 | `service=driveway` joining a street; `kerb=lowered/flush` | Small cut on that side only |
| Level crossings | HC 243, 291 | `railway=level_crossing` | 30 m cut |
| Taxi ranks | HC 240 | `amenity=taxi` | 12 m cut |
| Opposite a traffic island | HC 243 | `traffic_calming=island`, `crossing:island=yes` | 8 m cut |
| Cycle lanes, bus lanes | HC 240 / 140 | `cycleway:<side>=lane`, `busway:<side>=lane` | Whole side excluded |
| Double white centre lines | HC 240 | `overtaking=no` (a proxy) | Whole street excluded |
| Roundabouts, tunnels, trunk roads, private roads, home zones | HC 240/243 and common practice | Road tags | Whole street excluded |
| Obstruction on narrow streets | HC 242 | Mapped `width`, minus the parked car(s), less than 3 m | Excluded for that vehicle |
| Height, width and length limits | Signs mapped in OSM | `maxheight` / `maxwidth` / `maxlength` on the street or car park | Excluded for that vehicle |
| Night parking direction | HC 248 | Overnight stays | Reminder in the popup |

**What layer 0 can't see:** yellow lines, CPZs, pay and permit bays, loading bans, red routes and clearways. An
unsurveyed kerb that passes every national rule can still have double yellow lines. That is why unsurveyed
results are labelled and can be hidden. Removing that risk is the goal of layers 1 to 5.

## Layer 1: OpenStreetMap street-parking tags (built)

The app reads the OSM street parking scheme (`parking:<side>:*` with fees, max stay, access, zones and time
conditions) and the older `parking:lane` scheme. UK coverage is patchy: dense in a few city areas, absent in most
towns.

How to grow it:
- **StreetComplete** (a mobile OSM editor) has a street-parking overlay that lets volunteers survey kerbs as they
  walk. We can point contributors at the areas where users search most.
- **An in-app "Report the rules here" flow** (layer 4) that writes to OSM, with the user's consent and an OSM
  account, or to our own store for moderation first.
- Each result already links to its OSM way so users can fix it.

## Layer 2: council open data (Camden built; more councils next)

### Camden (pilot, built)

The app fetches Camden's open data live from the browser for every search inside the borough (`src/councils/`).
The API allows cross-origin requests, supports radius queries, and is under the Open Government Licence v3.0. The
licence attribution is shown in the app.

| Dataset | Id | Used for |
|---|---|---|
| Parking Bays | `7hiv-3r9k` | ~8,900 bays with type, times, max stay, length, number of spaces and CPZ. Updated daily |
| Controlled Parking Zones | `vf6e-iymu` | 53 zone polygons with Mon–Fri and Saturday control hours |
| Parking Suspensions | `av3b-8trg` | Live status per space: suspended today, or a suspension planned |

How it's used:
- **Times.** Bay "times of operation" text is translated into opening_hours syntax. Every one of the 65 distinct
  strings in the live dataset translates (the tests check this against a snapshot).
- **Bay types.**
  - Pay bays and shared pay/permit bays become paid during their hours.
  - Permit, residents', car club, doctor and diplomatic bays are permit-only during their hours.
  - Disabled, loading and EV bays are never offered.
  - Motorcycle, bicycle, bus and bike-hire bays are never for cars.
  - **Outside its hours every bay is an ordinary free kerb.**
- **Bays onto kerbs.** Each bay is matched to the nearest kerb line (so the correct side of the street) and covers
  the stretch its outline projects onto. Bays are authorised spaces, so they override the junction cut-out. Bays
  with no street nearby (mews, estates) are shown as they are.
- **Zones.** On unsurveyed kerbs inside a CPZ, everything outside bays counts as a single yellow line during the
  zone's hours. Zone membership is checked along the kerb, because streets cross zone boundaries.
- **Space size.** Bay length ÷ number of spaces gives a space length, which feeds the vehicle-size filter.

Real-data check (snapshot of 47 bays within 120 m of Fitzroy Street, 2-hour stay): **0 free on Monday at 11:00,
23 free from 19:00 and on Sunday morning, 1 on Saturday afternoon** (that zone is controlled until 18:30 on
Saturdays).

What Camden doesn't publish: **yellow lines**. Outside bays and outside zone hours, a kerb could still be double
yellow. Those kerbs stay *Unsurveyed*, with a "check for double yellow lines" note, until aerial markings (layer 5)
or a yellow-line dataset fill the gap. Camden's penalty charge notice datasets record contravention locations,
which could flag places where people often get tickets. That is worth exploring as a cross-check.

### Adding another council

1. Write an adapter in `src/councils/` that returns `CouncilData`: bays as engine tags (reuse `toOpeningHours`
   for their times text, extending it if their phrasing differs), and zones with opening_hours hours.
2. Register it in `src/councils/index.ts` with a bounding box.
3. Save a small real sample as test fixtures and assert that every times string and bay type in their full
   dataset is handled.
4. Councils whose data is only a file download (not a live API) need the pre-merged tile backend (step 4 of the
   pipeline below) instead of live fetching.

### Other councils found so far

| Council | What's published |
|---|---|
| [Camden](https://opendata.camden.gov.uk/Transport/Parking-Bay-Map/miup-aubx) | Parking bays with restriction type, times of operation, max stay, tariff, road name and CPZ |
| [City of Edinburgh](https://data.spatialhub.scot/dataset/car_parking-ce) (Spatial Hub Scotland) | Car parks, parking bays, parking zones. CPZs are also on [data.gov.uk](https://data.gov.uk/dataset/d6f99667-0a43-44d9-a352-3266d98fde75/controlled-parking-zones-cpz-city-of-edinburgh) |
| [York](https://data.yorkopendata.org/dataset/parking-zones/resource/45633278-5903-466a-aa1c-e5d99ecca81d) | Residents' priority parking zones (GeoJSON; the file is old, so check it is still current) |
| [Sheffield](https://data.gov.uk/dataset/sheffield-city-centre-parking-zones) | City-centre parking zones with rates and times |
| [Tunbridge Wells](https://www.data.gov.uk/dataset/twbc-open-data-resident-parking-zones8) | Resident parking zones (GeoJSON, shapefile, ArcGIS service) |
| [North Somerset](https://www.data.gov.uk/dataset/controlled-parking-spaces-nsc) | Controlled parking spaces |

Licence, freshness and schema need checking for each one before use. Most UK council data is under the Open
Government Licence.

**CPZ boundaries are the most valuable single dataset.** Inside a CPZ during its hours, every kerb is either a bay
(permit or pay) or single yellow line, unless signed otherwise. So one polygon plus its hours turns every unsurveyed
kerb inside it into "not free during these hours", which removes the main source of false positives in town
centres. Outside the hours, single yellow lines become legal, and only double yellow lines and bays still need
local data.

Pipeline:
1. One **adapter per source** turns that council's schema into a common kerb-rule model. The model is the same
   `parking:<side>:*` tag model the engine already reads, so nothing downstream changes.
2. **Conflate** bays and lines onto OSM ways by matching each bay to the nearest way and side (by distance and
   bearing). Zone polygons attach to every way inside them.
3. **Merge the layers.** Priority: official data > OSM explicit tags > national inference. Keep the source on
   every rule so the app can show it.
4. **Serve** the merged result as pre-built tiles from our own backend, refreshed nightly. This also replaces live
   Overpass queries, which a production app shouldn't depend on (see README).

## Layer 3: digital TROs (the national answer, coming)

The DfT's **D-TRO service** is a central, API-first store where traffic authorities publish orders in a
standard data model ([DfT GitHub](https://github.com/department-for-transport-public/D-TRO)). Status as of
November 2026, from DfT's repository and trade press:
- Data model v4.0.0 has been live in production since May 2026; v5.0.0 entered the integration environment in
  November 2026.
- The legal requirement for authorities to publish is expected **after February 2027**. DfT is still progressing
  the statutory instrument, so there is no fixed date yet
  ([Causeway summary](https://www.causeway.com/blog/dtro-funding-update-2027-deadline)).
- Each English highway authority gets a one-off £37,000 to prepare
  ([Traffic Technology Today](https://www.traffictechnologytoday.com/news/funding/dft-confirms-37k-d-tro-funding-for-each-english-highway-authority.html)).
- Councils are **not** being asked to digitise historic orders. Coverage will start with new and temporary orders
  and grow over years.

What to do now:
- Register for API access.
- Build an adapter from the D-TRO data model to our kerb-rule model against the integration environment.
- Treat D-TRO as the top-priority source wherever it has data.

Because historic orders won't be digitised, layers 1 and 2 stay necessary for the foreseeable future.

## Layer 4: area-wide rules and user reports

- **London red routes:** TfL publishes the Transport for London Road Network (TLRN, its red-route network) on
  its ArcGIS Hub. The [Google Dataset Search listing](https://datasetsearch.research.google.com/search?query=tlrn)
  shows it was last updated in 2022, so check how current it is. Red routes mean no stopping except in marked
  boxes. Ingest the network and exclude its kerbs.
- **Pavement parking:** banned London-wide, and in Scotland. In England outside London, the government has chosen
  to give councils local enforcement powers rather than a national ban, with secondary legislation planned for
  2026 ([gov.uk](https://www.gov.uk/government/consultations/managing-pavement-parking/outcome/pavement-parking-options-for-change-government-response)).
  - App change needed: in London and Scotland, don't suggest `half_on_kerb` or `on_kerb` parking unless it is
    explicitly signed (mapped as allowed).
  - Elsewhere, follow the local orders as councils adopt the new powers.
- **User reports:** "There are yellow lines here", "This is free after 6pm", ideally with a photo of the sign.
  Reports downgrade or upgrade a kerb's tier straight away. After review they are written back to OSM, so the
  improvement is shared.

## Layer 5: road markings from aerial photography (app side built; detector needs imagery)

A one-off survey photo can't show availability, but road markings stay put for years. So aerial imagery is a good
source for **where** restrictions are painted: double and single yellow lines, bays, zig-zags, red routes, bus
lanes and "keep clear" boxes. It can't show **when** they apply: hours are on signs.

- **Imagery:** aerial (planes) rather than satellite. UK yellow lines are 50–100 mm wide. That is visible at the
  12.5 cm per pixel or better that UK aerial surveys provide in towns, and not reliably at the best satellites'
  ~30 cm.
- **Licence:** most imagery licences forbid deriving a database from the photos, or charge separately for it.
  Permission to trace into OSM by hand (Bing, Esri) is not permission for automated extraction into our product.
  We need a commercial licence that explicitly covers derived data.
- **How the app uses it** (built: `src/uk/markings.ts`, format in [KERB_MARKINGS_FORMAT.md](KERB_MARKINGS_FORMAT.md)):
  - Restrictive markings remove unsurveyed kerbs. Errors in this direction only cost a suggestion, never a ticket.
  - Kerbs with no lines become **Lines checked**, with the photo date, and with a note if cars were parked there.
  - Painted bays are not suggested until their rules are known.
  - On mapped kerbs, mapped rules win, but a contradicting photo adds a warning and lowers the tier.
- **Detector:** classify short image strips along each kerb. Train it using council bay and yellow-line data as
  labels (layer 2), so a council with good data doubles as the training and test area. Re-run whenever new
  imagery arrives.
- **Pairs with street-level photos for signs:** Mapillary is openly licensed and detects many traffic signs.
  Google Street View's terms forbid extracting data.

## How to measure progress

Track, per council area: **the share of kerb length near where users actually search that has mapped (non-inferred)
rules**. Weight it by search volume. Use it to decide which council's data to ingest next, and where to point
contributors.

## Suggested order of work

1. ~~CPZ polygons, bays and live suspensions for Camden.~~ Built.
2. Next councils: Edinburgh (bays and zones on Spatial Hub Scotland), then the others above. Their bays are also
   the training and test labels for the aerial-imagery detector.
3. Aerial-imagery pilot in the same council area: licence imagery, train the detector, measure it against the
   council data, then publish `kerb-markings/1` files.
4. TfL red routes; pavement-parking rules for London and Scotland.
5. D-TRO adapter, ready before the legal requirement starts.
6. In-app reporting with OSM write-back.
7. A move from live Overpass queries to our own pre-merged tiles (needed anyway for production load).
