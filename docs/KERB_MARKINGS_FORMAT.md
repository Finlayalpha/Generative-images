# Kerb markings format (`kerb-markings/1`)

The interface between the aerial-imagery pipeline and the app. The detector, whoever builds it and whatever
imagery it uses, outputs this format. The app reads it (`src/data/markings.ts`) and merges it with the other rule
sources (`src/uk/markings.ts`).

## File

A GeoJSON `FeatureCollection` (coordinates in WGS84 `[lon, lat]`). Each feature is a stretch of kerb:

```json
{
  "type": "FeatureCollection",
  "format": "kerb-markings/1",
  "features": [
    {
      "type": "Feature",
      "geometry": { "type": "LineString", "coordinates": [[-0.1201, 51.5003], [-0.1189, 51.5003]] },
      "properties": {
        "marking": "double_yellow",
        "confidence": 0.93,
        "image_date": "2025-06-14",
        "source": "getmapping-2025-camden",
        "parked_vehicles": false
      }
    }
  ]
}
```

| Property | Required | Meaning |
|---|---|---|
| `marking` | yes | One of the values below |
| `confidence` | yes | Detector confidence, 0–1. The app ignores observations below **0.6** |
| `image_date` | yes | Date the photo was taken, `YYYY-MM-DD`. This is not the processing date: users see it ("Lines checked · Jun 2025") |
| `source` | yes | Imagery provider and survey identifier, for attribution and re-runs |
| `parked_vehicles` | no | `true` if vehicles were parked along this stretch in the photo |

Invalid features are dropped individually; they don't fail the file.

## Geometry

- Draw the line **along the kerb edge** the marking belongs to, in the direction of travel or against it (either
  works).
- It must not run down the road centreline. The app matches an observation to a kerb when the kerb passes within
  **3 m** of the line, so a centreline would match both sides.
- Split the line wherever the marking changes. Overlapping observations are allowed: the most restrictive wins.
- Stretches the detector couldn't see (trees, shadows, vehicles over the line) should be `occluded`, not left out,
  so the coverage is measurable.

## Marking values and what the app does with them

| `marking` | On a kerb with no mapped rules | On a kerb with mapped rules |
|---|---|---|
| `double_yellow` | No parking | Mapped rules kept; warning added; tier lowered to *Partly mapped* |
| `zigzag` | No parking | Same as above |
| `red_route` | No parking | Same as above |
| `keep_clear` | No parking | Same as above |
| `bus_lane` | No parking | Same as above |
| `single_yellow` | Restricted (the hours are on signs the photo can't show) | Same as above |
| `bay` | Not suggested, "check the sign" (most on-street bays are pay or permit) | No change |
| `clear` | Still free, tier raised to **Lines checked** with the photo date | No change |
| `occluded` | No change (still *Unsurveyed*) | No change |

National-rule cut-outs (junctions, zig-zag zones around mapped crossings, driveways, …) apply on top: a `clear`
observation never overrides them.

Mapped rules win over imagery because they come from a survey or official data. A contradicting photo still
matters: the markings may have changed since mapping, so the user is warned.

## Serving

The app requests observations around the destination from the URL set at build time in `VITE_MARKINGS_URL`, with
`{lat}`, `{lon}` and `{radius}` placeholders:

```
VITE_MARKINGS_URL="https://api.example.org/markings?lat={lat}&lon={lon}&radius={radius}" npm run build
```

With no URL configured, the app works without imagery. If the request fails, the search carries on without it.

## Producing it: the pipeline

1. **Imagery:** licensed aerial photography at 12.5 cm per pixel or better, with a licence that allows deriving
   data (see the strategy doc).
2. **Kerb lines:** start from the app's own kerb lines (OSM centreline ± offset), then search a ±3 m band either
   side for the actual kerb edge, because road widths vary.
3. **Chips:** cut the photo into small image strips along each kerb (e.g. 2 m long × 1.5 m wide), rotated so the
   kerb runs horizontally.
4. **Classify** each chip into the marking values above, plus whether a vehicle is present.
   - Training labels: council datasets that record bays and yellow lines (Camden, Edinburgh, …), already
     conflated onto kerbs, plus OSM kerbs with explicit `parking:*:restriction` tags.
   - Public research datasets with aerial road-marking labels (e.g. SkyScapes) help pre-train.
5. **Smooth and merge** neighbouring chips into runs. Drop runs shorter than ~2 m unless they are restrictive.
6. **Validate** against held-out council data. Hand-check a random sample before publishing each area.
7. **Publish** per area, with the survey date. Re-run when new imagery arrives (typically every 1–3 years).
