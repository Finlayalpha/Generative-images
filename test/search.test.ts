import { describe, expect, it } from 'vitest';
import type { LatLon, ParkingData, StreetWay } from '../src/data/overpass';
import { distanceM, lengthWithin, nearestOnLine, sideCompass, splitLine } from '../src/geo/measure';
import { estimateKerbCapacity, likelihood } from '../src/search/likelihood';
import { evaluate, score, sortResults } from '../src/search/rank';
import { buildAroundQuery } from '../src/data/overpass';

const ORIGIN: LatLon = { lat: 51.5, lon: -0.12 };
/** Offset a point by metres east / north. */
const at = (east: number, north: number): LatLon => ({
  lat: ORIGIN.lat + north / 111_320,
  lon: ORIGIN.lon + east / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180)),
});
const mon10 = { start: new Date(2026, 10, 23, 10, 0), minutes: 120 };

describe('geometry', () => {
  it('haversine distance', () => {
    expect(distanceM(ORIGIN, at(300, 400))).toBeCloseTo(500, -1);
  });

  it('nearest point on a polyline', () => {
    const line = [at(-100, 50), at(100, 50)];
    const n = nearestOnLine(line, ORIGIN);
    expect(n.distance).toBeCloseTo(50, 0);
    expect(distanceM(n.point, at(0, 50))).toBeLessThan(0.5);
  });

  it('length of a line inside a circle', () => {
    // Horizontal line through the centre, radius 100 → 200 m inside.
    expect(lengthWithin([at(-500, 0), at(500, 0)], ORIGIN, 100)).toBeCloseTo(200, -1);
  });

  it('splits long lines into blocks', () => {
    const pieces = splitLine([at(0, 0), at(250, 0)], 100);
    expect(pieces.length).toBe(3);
    for (const p of pieces) expect(distanceM(p[0]!, p[p.length - 1]!)).toBeCloseTo(250 / 3, 0);
    expect(splitLine([at(0, 0), at(50, 0)], 100).length).toBe(1);
  });

  it('names kerb sides by compass direction', () => {
    const eastbound = [at(0, 0), at(100, 0)];
    expect(sideCompass(eastbound, 'right')).toBe('south');
    expect(sideCompass(eastbound, 'left')).toBe('north');
    const northbound = [at(0, 0), at(0, 100)];
    expect(sideCompass(northbound, 'right')).toBe('east');
  });
});

describe('likelihood', () => {
  it('estimates kerb capacity from length and orientation', () => {
    expect(estimateKerbCapacity(60).capacity).toBe(10);
    expect(estimateKerbCapacity(60, 'perpendicular').capacity).toBe(21);
    expect(estimateKerbCapacity(60, undefined, '4')).toEqual({ capacity: 4, known: true });
  });

  it('more spaces and better data mean a higher chance', () => {
    const t = mon10.start;
    expect(likelihood('kerb', 'high', 20, false, t).probability).toBeGreaterThan(likelihood('kerb', 'high', 3, false, t).probability);
    expect(likelihood('kerb', 'high', 10, false, t).probability).toBeGreaterThan(likelihood('kerb', 'medium', 10, false, t).probability);
    expect(likelihood('kerb', 'high', 0, false, t).probability).toBe(0);
  });

  it('score decays with distance', () => {
    expect(score(0.8, 100)).toBeGreaterThan(score(0.8, 300));
    expect(score(0.8, 0)).toBeCloseTo(0.8);
  });
});

describe('ranking', () => {
  const street = (id: number, north: number, tags: Record<string, string>, halfLength = 190): StreetWay => ({
    id,
    tags: { highway: 'residential', name: `Street ${id}`, ...tags },
    geometry: [at(-halfLength, north), at(halfLength, north)],
  });
  const data: ParkingData = {
    streets: [
      // Close, short (30 m ≈ 5 spaces), fee not mapped (medium confidence).
      street(1, 40, { 'parking:both': 'lane' }, 15),
      // Further, explicitly free.
      street(2, 250, { 'parking:both': 'lane', 'parking:both:fee': 'no' }),
      // Close but paid: must not be listed.
      street(3, -30, { 'parking:both': 'lane', 'parking:both:fee': 'yes' }),
      // Outside the radius.
      street(4, 900, { 'parking:both': 'lane', 'parking:both:fee': 'no' }),
    ],
    carParks: [{ id: 9, type: 'way', center: at(100, -100), tags: { amenity: 'parking', fee: 'no', capacity: '50' } }],
  };

  const { places, results } = evaluate(data, ORIGIN, 400, mon10);

  it('evaluates everything for the map but lists only free places in range', () => {
    // Street 1 (30 m) is one block per side; the 380 m streets are 4 blocks per side.
    expect(places.length).toBe(2 + 3 * 2 * 4 + 1);
    const ways = new Set(results.map((r) => r.id.split(':')[0]));
    expect([...ways].sort()).toEqual(['w1', 'w2', 'w9']);
    expect(results.filter((r) => r.id.startsWith('w2:')).length).toBe(8);
  });

  it('nearer blocks of the same street rank above further ones', () => {
    const w2 = sortResults(results.filter((r) => r.id.startsWith('w2:left')), 'best');
    expect(w2[0]!.distance).toBeLessThan(w2[w2.length - 1]!.distance);
  });

  it('sorts by distance', () => {
    const d = sortResults(results, 'nearest').map((r) => r.distance);
    expect(d).toEqual([...d].sort((a, b) => a - b));
    expect(sortResults(results, 'nearest')[0]!.id).toMatch(/^w1:/);
  });

  it('sorts by likelihood', () => {
    const p = sortResults(results, 'likely').map((r) => r.likelihood.probability);
    expect(p).toEqual([...p].sort((a, b) => b - a));
  });

  it('best match trades distance against likelihood', () => {
    const best = sortResults(results, 'best');
    const s = best.map((r) => r.score);
    expect(s).toEqual([...s].sort((a, b) => b - a));
    // A big, explicitly free car park ~140 m away beats a short nearby kerb whose fee isn't mapped.
    expect(best[0]!.id).toBe('w9');
  });

  it('labels kerbs by compass side', () => {
    expect(results.find((r) => r.id === 'w1:left')!.detail).toBe('north side');
  });
});

describe('overpass radius query', () => {
  it('uses around filters', () => {
    const q = buildAroundQuery(ORIGIN, 400);
    expect(q).toContain('way(around:400,51.500000,-0.120000)["highway"]');
    expect(q).toContain('nwr(around:400,51.500000,-0.120000)["amenity"="parking"]');
  });
});

describe('direction', () => {
  it('gives compass direction from destination', async () => {
    const { directionTo } = await import('../src/geo/measure');
    expect(directionTo(ORIGIN, at(0, 100))).toBe('N');
    expect(directionTo(ORIGIN, at(-100, -100))).toBe('SW');
  });
});

describe('midpoint', () => {
  it('is halfway along the line by length', async () => {
    const { midpoint } = await import('../src/geo/measure');
    const m = midpoint([at(0, 0), at(100, 0), at(100, 100)]);
    expect(distanceM(m, at(100, 0))).toBeLessThan(0.5);
  });
});
