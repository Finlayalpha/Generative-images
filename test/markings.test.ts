import { describe, expect, it } from 'vitest';
import { formatImageDate, parseMarkings, type KerbMarking, type MarkingType } from '../src/data/markings';
import type { LatLon, ParkingData, StreetWay } from '../src/data/overpass';
import { offsetLine } from '../src/geo/offset';
import { lineLength, sliceLine } from '../src/geo/measure';
import { evaluate, type SearchOptions } from '../src/search/rank';
import { PRESETS } from '../src/vehicle';

const ORIGIN: LatLon = { lat: 51.5, lon: -0.12 };
const at = (east: number, north: number): LatLon => ({
  lat: ORIGIN.lat + north / 111_320,
  lon: ORIGIN.lon + east / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180)),
});
const hatch = PRESETS.find((p) => p.id === 'hatch')!;
const opts: SearchOptions = {
  destination: ORIGIN,
  radiusM: 400,
  stay: { start: new Date(2026, 10, 23, 10, 0), minutes: 120 },
  vehicle: hatch,
  includeUnsurveyed: true,
};

// A 200 m east-west street: left = north kerb, right = south kerb.
const street = (tags: Record<string, string> = {}): StreetWay => ({
  id: 1,
  tags: { highway: 'residential', name: 'Test Road', ...tags },
  geometry: [at(-100, 0), at(100, 0)],
  nodes: [1, 2],
});

/** An observation along one kerb, `offset` metres from the centreline, between `from` and `to` metres. */
function obs(side: 'left' | 'right', marking: MarkingType, from = 0, to = 200, extra: Partial<KerbMarking> = {}, offset = 5): KerbMarking {
  const kerb = offsetLine(street().geometry, side === 'right' ? offset : -offset);
  return { marking, geometry: sliceLine(kerb, from, Math.min(to, lineLength(kerb))), confidence: 0.9, imageDate: '2025-06-14', source: 'test', ...extra };
}

function run(markings: KerbMarking[], tags: Record<string, string> = {}, points: ParkingData['points'] = []) {
  const data: ParkingData = { streets: [street(tags)], points, carParks: [], markings };
  return evaluate(data, opts);
}

/** Total length of listed results on one side, and their tiers. */
function side(markings: KerbMarking[], s: 'left' | 'right', tags: Record<string, string> = {}) {
  const { places, results } = run(markings, tags);
  const mine = results.filter((r) => r.id.startsWith(`w1:${s}`));
  return {
    length: mine.reduce((n, r) => n + lineLength(r.geometry), 0),
    tiers: [...new Set(mine.map((r) => r.tier))],
    places: places.filter((p) => p.id.startsWith(`w1:${s}`)),
    results: mine,
  };
}

describe('kerb-markings format', () => {
  const feature = (props: Record<string, unknown>, coords: unknown = [[-0.12, 51.5], [-0.119, 51.5]]) => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: coords },
    properties: { marking: 'double_yellow', confidence: 0.9, image_date: '2025-06-14', source: 's', ...props },
  });

  it('parses valid features and rejects bad ones', () => {
    const { markings, rejected } = parseMarkings({
      type: 'FeatureCollection',
      features: [
        feature({}),
        feature({ parked_vehicles: true, marking: 'clear' }),
        feature({ marking: 'purple_line' }),
        feature({ confidence: 1.4 }),
        feature({ image_date: 'June 2025' }),
        feature({}, [[-0.12, 51.5]]),
      ],
    });
    expect(markings.length).toBe(2);
    expect(rejected).toBe(4);
    expect(markings[0]!.geometry[0]).toEqual({ lat: 51.5, lon: -0.12 }); // [lon, lat] order
    expect(markings[1]!.parkedVehicles).toBe(true);
  });

  it('ignores things that are not a FeatureCollection', () => {
    expect(parseMarkings(null).markings).toEqual([]);
    expect(parseMarkings({ type: 'Feature' }).markings).toEqual([]);
  });

  it('formats photo dates', () => expect(formatImageDate('2025-06-14')).toBe('Jun 2025'));
});

describe('applying aerial markings to unsurveyed streets', () => {
  it('without imagery, both kerbs are unsurveyed', () => {
    expect(side([], 'left').tiers).toEqual(['unsurveyed']);
  });

  it('a clear kerb becomes "Lines checked", with the date; the other side is unchanged', () => {
    const m = [obs('left', 'clear', 0, 200, { parkedVehicles: true })];
    const left = side(m, 'left');
    expect(left.tiers).toEqual(['checked']);
    expect(left.results[0]!.imageDate).toBe('2025-06-14');
    expect(left.results[0]!.assessment.reasons.join(' ')).toContain('Cars were parked here');
    expect(side(m, 'right').tiers).toEqual(['unsurveyed']);
  });

  it('double yellow lines remove that stretch only', () => {
    const left = side([obs('left', 'double_yellow', 0, 80)], 'left');
    expect(left.length).toBeGreaterThan(110);
    expect(left.length).toBeLessThan(130);
    const dy = left.places.find((p) => p.assessment.status === 'no_parking')!;
    expect(dy.assessment.reasons[0]).toBe('Double yellow lines: no waiting at any time (aerial photo, Jun 2025)');
  });

  it('single yellow lines are treated as restricted (hours unknown)', () => {
    const left = side([obs('left', 'single_yellow')], 'left');
    expect(left.length).toBe(0);
    expect(left.places.every((p) => p.assessment.status === 'restricted')).toBe(true);
  });

  it('marked bays are not suggested until their rules are known', () => {
    const left = side([obs('left', 'bay')], 'left');
    expect(left.length).toBe(0);
    expect(left.places[0]!.assessment.reasons[0]).toContain('check the sign');
  });

  it('low-confidence observations are ignored', () => {
    expect(side([obs('left', 'double_yellow', 0, 200, { confidence: 0.4 })], 'left').length).toBeGreaterThan(190);
  });

  it('observations only match their own kerb', () => {
    // Observation 8 m south of the centreline: matches the south kerb (right), not the north one.
    const m = [obs('right', 'double_yellow', 0, 200, {}, 6.5)];
    expect(side(m, 'right').length).toBe(0);
    expect(side(m, 'left').length).toBeGreaterThan(190);
  });

  it('the most restrictive overlapping observation wins', () => {
    const m = [obs('left', 'clear'), obs('left', 'double_yellow', 50, 100, { confidence: 0.7 })];
    const left = side(m, 'left');
    expect(left.length).toBeGreaterThan(140);
    expect(left.length).toBeLessThan(160);
  });

  it('a free stretch split by observation edges still counts as one gap', () => {
    // A 4 m "clear" observation in the middle: the kerb is one continuous 200 m gap.
    const left = side([obs('left', 'clear', 98, 102)], 'left');
    expect(left.length).toBeGreaterThan(190);
    expect(left.results.every((r) => r.fit.verdict !== 'too_big')).toBe(true);
  });

  it('national-rule zones still apply over a clear observation', () => {
    const zebra = [{ id: 9, ...at(0, 0), tags: { highway: 'crossing', crossing: 'zebra' } }];
    const { results } = run([obs('left', 'clear')], {}, zebra);
    const len = results.filter((r) => r.id.startsWith('w1:left')).reduce((n, r) => n + lineLength(r.geometry), 0);
    expect(len).toBeLessThan(170);
  });
});

describe('aerial markings on mapped streets', () => {
  const freeTags = { 'parking:both': 'lane', 'parking:both:fee': 'no' };

  it('mapped rules win, but a contradicting photo warns and lowers the tier', () => {
    const left = side([obs('left', 'double_yellow', 0, 50)], 'left', freeTags);
    expect(left.length).toBeGreaterThan(190); // still listed
    const conflicted = left.results.filter((r) => r.tier === 'partial');
    expect(conflicted.length).toBeGreaterThan(0);
    expect(conflicted[0]!.assessment.reasons[0]).toContain('shows double yellow lines here');
    expect(left.results.some((r) => r.tier === 'confirmed')).toBe(true);
  });

  it('a clear photo does not change mapped rules', () => {
    expect(side([obs('left', 'clear')], 'left', freeTags).tiers).toEqual(['confirmed']);
  });
});
