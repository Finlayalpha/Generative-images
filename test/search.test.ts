import { describe, expect, it } from 'vitest';
import type { LatLon, ParkingData, PointFeature, StreetWay } from '../src/data/overpass';
import { buildAroundQuery } from '../src/data/overpass';
import { directionTo, distanceM, lengthWithin, lineLength, midpoint, nearestOnLine, runsAlong, sideCompass, sliceLine, splitLine } from '../src/geo/measure';
import { evaluate, sortResults, type SearchOptions } from '../src/search/rank';
import { buildKerbs } from '../src/uk/kerbs';
import { inferSide } from '../src/uk/streets';
import { buildZones, hasZigzags } from '../src/uk/zones';
import { carParkFit, kerbFit, obstructionFit, parseLengthM, PRESETS, roadFit, type Vehicle } from '../src/vehicle';

const ORIGIN: LatLon = { lat: 51.5, lon: -0.12 };
/** A point `east` / `north` metres from ORIGIN. */
const at = (east: number, north: number): LatLon => ({
  lat: ORIGIN.lat + north / 111_320,
  lon: ORIGIN.lon + east / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180)),
});
const mon10 = { start: new Date(2026, 10, 23, 10, 0), minutes: 120 };
const hatch: Vehicle = PRESETS.find((p) => p.id === 'hatch')!;
const bigVan: Vehicle = PRESETS.find((p) => p.id === 'lwb')!;

/** Free length (m) of a street side after cutting zones. */
function freeLength(data: ParkingData, side: 'left' | 'right', v: Vehicle = hatch, wayId = 1): number {
  return buildKerbs(data, buildZones(data), mon10, v)
    .filter((k) => k.wayId === wayId && k.side === side && k.assessment.status === 'free')
    .reduce((s, k) => s + lineLength(k.geometry), 0);
}

describe('geometry', () => {
  it('haversine distance', () => expect(distanceM(ORIGIN, at(300, 400))).toBeCloseTo(500, -1));

  it('nearest point on a polyline', () => {
    const n = nearestOnLine([at(-100, 50), at(100, 50)], ORIGIN);
    expect(n.distance).toBeCloseTo(50, 0);
    expect(distanceM(n.point, at(0, 50))).toBeLessThan(0.5);
  });

  it('length within a circle', () => expect(lengthWithin([at(-500, 0), at(500, 0)], ORIGIN, 100)).toBeCloseTo(200, -1));

  it('slices and splits lines', () => {
    const line = [at(0, 0), at(250, 0)];
    expect(lineLength(sliceLine(line, 50, 120))).toBeCloseTo(70, 0);
    const pieces = splitLine(line, 100);
    expect(pieces.length).toBe(3);
    for (const p of pieces) expect(lineLength(p)).toBeCloseTo(250 / 3, 0);
  });

  it('finds runs along a line', () => {
    const runs = runsAlong([at(0, 0), at(100, 0)], (p) => distanceM(p, at(50, 0)) < 10);
    expect(runs.map((r) => r.value)).toEqual([false, true, false]);
    expect(Math.abs(runs[1]!.to - runs[1]!.from - 20)).toBeLessThan(2);
  });

  it('compass names and directions', () => {
    expect(sideCompass([at(0, 0), at(100, 0)], 'right')).toBe('south');
    expect(sideCompass([at(0, 0), at(100, 0)], 'left')).toBe('north');
    expect(directionTo(ORIGIN, at(-100, -100))).toBe('SW');
    expect(distanceM(midpoint([at(0, 0), at(100, 0), at(100, 100)]), at(100, 0))).toBeLessThan(0.5);
  });
});

describe('vehicle size', () => {
  it('parses metric and imperial lengths', () => {
    expect(parseLengthM('2.1')).toBe(2.1);
    expect(parseLengthM('2,1 m')).toBe(2.1);
    expect(parseLengthM(`6'6"`)).toBeCloseTo(1.98, 2);
    expect(parseLengthM('7 ft')).toBeCloseTo(2.13, 2);
    expect(parseLengthM('default')).toBeNull();
  });

  it('car park height limits', () => {
    expect(carParkFit(hatch, { maxheight: '2.0' }).verdict).toBe('fits');
    expect(carParkFit(bigVan, { maxheight: '2.0' }).verdict).toBe('too_big');
    expect(carParkFit(bigVan, { maxheight: `6'6"` }).notes[0]).toContain(`6'6"`);
  });

  it('unmapped multi-storey height: tall vehicles excluded, borderline flagged', () => {
    expect(carParkFit(bigVan, { parking: 'multi-storey' }).verdict).toBe('too_big');
    expect(carParkFit({ ...hatch, height: 2.0 }, { parking: 'multi-storey' }).verdict).toBe('check');
    expect(carParkFit(hatch, { parking: 'multi-storey' }).verdict).toBe('fits');
  });

  it('street restrictions (low bridge)', () => {
    expect(roadFit(bigVan, { maxheight: '2.2' }).verdict).toBe('too_big');
    expect(roadFit(hatch, { maxheight: '2.2' }).verdict).toBe('fits');
  });

  it('bays', () => {
    expect(kerbFit(hatch, 'perpendicular', true).verdict).toBe('fits');
    expect(kerbFit(bigVan, 'perpendicular', true).verdict).toBe('too_big');
    expect(kerbFit(bigVan, 'parallel', true).verdict).toBe('check');
    expect(kerbFit(bigVan, 'parallel', false).verdict).toBe('fits');
  });

  it('narrow streets', () => {
    expect(obstructionFit(hatch, { width: '5' }, true).verdict).toBe('too_big'); // 5 - 1.8 - 1.9 < 3
    expect(obstructionFit(hatch, { width: '5' }, false).verdict).toBe('fits');
    expect(obstructionFit(hatch, {}, true).verdict).toBe('fits');
  });
});

describe('UK street eligibility', () => {
  it('ordinary residential street is ok', () => expect(inferSide({ highway: 'residential' }, 'left').kind).toBe('ok'));
  it('service roads and slip roads are skipped', () => {
    expect(inferSide({ highway: 'service' }, 'left').kind).toBe('skip');
    expect(inferSide({ highway: 'primary_link' }, 'left').kind).toBe('skip');
  });
  it.each([
    [{ highway: 'trunk' }, 'Trunk'],
    [{ highway: 'residential', access: 'private' }, 'Private'],
    [{ highway: 'residential', junction: 'roundabout' }, 'Roundabout'],
    [{ highway: 'unclassified', overtaking: 'no' }, 'Double white'],
    [{ highway: 'living_street' }, 'Home zone'],
  ])('%o excluded', (tags, reason) => {
    const e = inferSide(tags as Record<string, string>, 'left');
    expect(e.kind).toBe('excluded');
    expect(e.kind === 'excluded' && e.reason).toContain(reason);
  });
  it('cycle and bus lanes exclude only their side', () => {
    const tags = { highway: 'primary', 'cycleway:left': 'lane', 'cycleway:left:lane': 'exclusive' };
    expect(inferSide(tags, 'left').kind).toBe('excluded');
    expect(inferSide(tags, 'right').kind).toBe('ok');
    expect(inferSide({ highway: 'secondary', 'busway:right': 'lane' }, 'right').kind).toBe('excluded');
  });
  it('main roads and fast roads carry warnings', () => {
    const e = inferSide({ highway: 'primary', maxspeed: '40 mph' }, 'left');
    expect(e.kind).toBe('ok');
    const notes = e.kind === 'ok' ? e.notes.join(' ') : '';
    expect(notes).toContain('red route');
    expect(notes).toContain('lights');
  });
});

describe('UK national rules: zones', () => {
  // A 300 m east-west street, joined in the middle by a side road going north.
  const main: StreetWay = { id: 1, tags: { highway: 'residential', name: 'Main St' }, geometry: [at(-150, 0), at(0, 0), at(150, 0)], nodes: [1, 2, 3] };
  const side: StreetWay = { id: 2, tags: { highway: 'residential' }, geometry: [at(0, 0), at(0, 150)], nodes: [2, 4] };
  const base: ParkingData = { streets: [main, side], points: [], carParks: [] };

  it('a node where three arms meet is a junction; a split way is not', () => {
    expect(buildZones(base).length).toBe(1);
    const split: ParkingData = {
      streets: [
        { id: 1, tags: { highway: 'residential' }, geometry: [at(-150, 0), at(0, 0)], nodes: [1, 2] },
        { id: 3, tags: { highway: 'residential' }, geometry: [at(0, 0), at(150, 0)], nodes: [2, 3] },
      ],
      points: [],
      carParks: [],
    };
    expect(buildZones(split).length).toBe(0);
  });

  it('cuts ~28 m around the junction from both kerbs', () => {
    expect(freeLength({ ...base, streets: [main] }, 'left')).toBeCloseTo(300, -1);
    for (const s of ['left', 'right'] as const) {
      const cut = 300 - freeLength(base, s);
      expect(cut).toBeGreaterThan(24);
      expect(cut).toBeLessThan(32);
    }
  });

  it('only controlled crossings have zig-zags', () => {
    expect(hasZigzags({ highway: 'crossing', crossing: 'traffic_signals' })).toBe(true);
    expect(hasZigzags({ highway: 'crossing', crossing: 'uncontrolled', crossing_ref: 'zebra' })).toBe(true);
    expect(hasZigzags({ highway: 'crossing', crossing: 'marked', 'crossing:markings': 'zebra' })).toBe(true);
    expect(hasZigzags({ highway: 'crossing', crossing: 'uncontrolled' })).toBe(false);
  });

  it('zebra crossing removes ~35 m from both kerbs', () => {
    const zebra: PointFeature = { id: 9, ...at(-80, 0), tags: { highway: 'crossing', crossing: 'zebra' } };
    const data: ParkingData = { streets: [main], points: [zebra], carParks: [] };
    for (const s of ['left', 'right'] as const) {
      const cut = 300 - freeLength(data, s);
      expect(cut).toBeGreaterThan(30);
      expect(cut).toBeLessThan(37);
    }
  });

  it('a bus stop on one pavement only affects that kerb', () => {
    const stop: PointFeature = { id: 9, ...at(60, 7), tags: { highway: 'bus_stop' } }; // north pavement
    const data: ParkingData = { streets: [main], points: [stop], carParks: [] };
    expect(300 - freeLength(data, 'left')).toBeGreaterThan(20); // left of an eastbound way = north
    expect(freeLength(data, 'right')).toBeCloseTo(300, -1);
  });

  it('a driveway only cuts the kerb on its own side', () => {
    const drive: StreetWay = { id: 5, tags: { highway: 'service', service: 'driveway' }, geometry: [at(0, 0), at(0, -20)], nodes: [2, 6] };
    const data: ParkingData = { streets: [main, drive], points: [], carParks: [] };
    expect(buildZones(data).length).toBe(1); // a driveway, not a junction
    expect(300 - freeLength(data, 'right')).toBeGreaterThan(4); // south side
    expect(freeLength(data, 'left')).toBeCloseTo(300, -1);
  });

  it('gaps too short for the vehicle are not offered', () => {
    // Two zebra crossings 41 m apart leave a ~5 m gap between their zig-zags.
    const p = (id: number, e: number): PointFeature => ({ id, ...at(e, 0), tags: { highway: 'crossing', crossing: 'zebra' } });
    const data: ParkingData = { streets: [main], points: [p(8, -20), p(9, 21)], carParks: [] };
    const pieces = buildKerbs(data, buildZones(data), mon10, hatch).filter((k) => k.side === 'left' && k.assessment.status === 'free');
    const gap = pieces.find((k) => lineLength(k.geometry) < 10);
    expect(gap?.fit.verdict).toBe('too_big');
  });

  it('junction distance does not apply to mapped bays', () => {
    const mapped: StreetWay = { ...main, tags: { ...main.tags, 'parking:both': 'lane', 'parking:both:fee': 'no' } };
    const data: ParkingData = { streets: [mapped, side], points: [], carParks: [] };
    expect(freeLength(data, 'left')).toBeCloseTo(300, -1);
  });
});

describe('ranking', () => {
  const street = (id: number, north: number, tags: Record<string, string>): StreetWay => ({
    id,
    tags: { highway: 'residential', name: `Street ${id}`, ...tags },
    geometry: [at(-40, north), at(40, north)],
    nodes: [id * 10, id * 10 + 1],
  });
  const data: ParkingData = {
    streets: [
      street(1, 30, {}), // unsurveyed, nearest
      street(2, 120, { 'parking:both': 'lane', 'parking:both:fee': 'no' }), // confirmed
      street(3, 60, { 'parking:both': 'lane' }), // partial (fee unknown)
      street(4, -50, { 'parking:both': 'lane', 'parking:both:fee': 'yes' }), // paid: never listed
      street(5, 80, { maxheight: '2.2' }), // low bridge
      street(6, 900, { 'parking:both': 'lane', 'parking:both:fee': 'no' }), // out of range
    ],
    points: [],
    carParks: [{ id: 9, type: 'way', center: at(0, -150), tags: { amenity: 'parking', fee: 'no', parking: 'multi-storey', maxheight: '2.0' } }],
  };
  const opts: SearchOptions = { destination: ORIGIN, radiusM: 400, stay: mon10, vehicle: hatch, includeUnsurveyed: true };
  const ways = (ids: string[]) => [...new Set(ids.map((id) => id.split(':')[0]))].sort();

  it('lists free, in-range places the vehicle fits', () => {
    const { results } = evaluate(data, opts);
    expect(ways(results.map((r) => r.id))).toEqual(['w1', 'w2', 'w3', 'w5', 'w9']);
  });

  it('tiers', () => {
    const { results } = evaluate(data, opts);
    const tier = (w: string) => results.find((r) => r.id.split(':')[0] === w)!.tier;
    expect(tier('w1')).toBe('unsurveyed');
    expect(tier('w2')).toBe('confirmed');
    expect(tier('w3')).toBe('partial');
  });

  it('can hide unsurveyed streets', () => {
    const { results } = evaluate(data, { ...opts, includeUnsurveyed: false });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.tier !== 'unsurveyed')).toBe(true);
  });

  it('filters by vehicle size', () => {
    const { results } = evaluate(data, { ...opts, vehicle: bigVan });
    expect(ways(results.map((r) => r.id))).toEqual(['w1', 'w2', 'w3']); // no low-bridge street, no multi-storey
  });

  it('sorts by distance, or by rule certainty then distance', () => {
    const { results } = evaluate(data, opts);
    const nearest = sortResults(results, 'nearest');
    const d = nearest.map((r) => r.distance);
    expect(d).toEqual([...d].sort((a, b) => a - b));
    expect(nearest[0]!.id).toMatch(/^w1:/);
    const certain = sortResults(results, 'certain');
    expect(certain[0]!.tier).toBe('confirmed');
    expect(certain[certain.length - 1]!.tier).toBe('unsurveyed');
  });
});

describe('overpass query', () => {
  it('loads roads with node ids, rule-relevant points and car parks', () => {
    const q = buildAroundQuery(ORIGIN, 400);
    expect(q).toContain('way(around:400,51.500000,-0.120000)["highway"~"^(');
    expect(q).toContain('out body geom;');
    expect(q).toContain('node(around:430,51.500000,-0.120000)["railway"="level_crossing"]');
    expect(q).toContain('nwr(around:400,51.500000,-0.120000)["amenity"="parking"]');
  });
});
