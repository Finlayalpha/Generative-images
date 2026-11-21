import { describe, expect, it } from 'vitest';
import { applySuspensions, bayEffect, bayFromRow, zoneFromRow, type CamdenBayRow, type CamdenSuspensionRow, type CamdenZoneRow } from '../src/councils/camden';
import { toOpeningHours } from '../src/councils/times';
import type { CouncilBay, CouncilData, CouncilZone } from '../src/councils/types';
import type { LatLon, ParkingData, StreetWay } from '../src/data/overpass';
import { lineLength, pointInPolygon } from '../src/geo/measure';
import { evaluate, type SearchOptions } from '../src/search/rank';
import { PRESETS } from '../src/vehicle';
import timesFixture from './fixtures/camden-times.json';
import typesFixture from './fixtures/camden-restriction-types.json';
import baysFixture from './fixtures/camden-bays-fitzrovia.json';
import zoneFixture from './fixtures/camden-zone-ca-e.json';
import suspensionsFixture from './fixtures/camden-suspensions-fitzrovia.json';

// Mon 23 Nov 2026 / Sun 22 Nov 2026, local time.
const mon = (h: number, m = 0) => new Date(2026, 10, 23, h, m);
const sun = (h: number) => new Date(2026, 10, 22, h, 0);
const hatch = PRESETS.find((p) => p.id === 'hatch')!;
const bigVan = PRESETS.find((p) => p.id === 'lwb')!;

const realBays = (baysFixture as CamdenBayRow[]).map(bayFromRow).filter((b): b is CouncilBay => b !== null);
const realZone = zoneFromRow((zoneFixture as CamdenZoneRow[])[0]!)!;

describe('council times → opening_hours', () => {
  it('reads every times string in the live Camden dataset', () => {
    const rows = timesFixture as { times_of_operation: string; n: string }[];
    const failed = rows.filter((r) => toOpeningHours(r.times_of_operation) === null);
    expect(failed).toEqual([]);
    expect(rows.reduce((s, r) => s + Number(r.n), 0)).toBeGreaterThan(8000);
  });

  it.each([
    ['at any time', '24/7'],
    ['mon-fri 08:30-18:30, sat 08:30-13:30', 'Mo-Fr 08:30-18:30, Sa 08:30-13:30'],
    ['mon-fri 08:00-09:00 & 15:00-17:00', 'Mo-Fr 08:00-09:00,15:00-17:00'],
    ['mon-fri 08:30-23:00 & sat-sun at any time', 'Mo-Fr 08:30-23:00, Sa-Su 00:00-24:00'],
    ['mon-sun 06:00- 00:00', 'Mo-Su 06:00-24:00'],
    ['sat and sun 09:30 - 17:30', 'Sa,Su 09:30-17:30'],
  ])('%s', (input, expected) => expect(toOpeningHours(input)).toBe(expected));

  it('refuses to guess', () => {
    expect(toOpeningHours('N/A')).toBeNull();
    expect(toOpeningHours('during school term times')).toBeNull();
    expect(toOpeningHours('mon-fri')).toBeNull();
  });
});

describe('Camden bay types', () => {
  it('classifies every restriction type in the live dataset', () => {
    for (const r of typesFixture as { restriction_type: string }[]) expect(bayEffect(r.restriction_type)).toBeTruthy();
  });

  it.each([
    ['paid-for', 'paid'],
    ['paid-for / resident permit holders', 'paid'],
    ['resident permit holders only', 'access'],
    ['car club', 'access'],
    ['free', 'free'],
    ['disabled (blue badge)', 'restriction'],
    ['loading / resident permit holders', 'restriction'],
    ['paid-for (solo motorcycles only)', 'restriction'],
  ])('%s → %s', (t, kind) => expect(bayEffect(t).kind).toBe(kind));

  it('motorcycle and bike bays are never for cars', () => {
    const e = bayEffect('paid-for (solo motorcycles only)');
    expect(e.kind === 'restriction' && e.always).toBe(true);
  });
});

describe('real Camden bays (Fitzrovia sample)', () => {
  const bay = (type: string) => realBays.find((b) => b.description.toLowerCase().startsWith(type))!;

  it('parses every bay in the sample', () => {
    expect(realBays.length).toBe((baysFixture as unknown[]).length);
    expect(realBays.every((b) => !b.uncertain)).toBe(true);
  });

  it('builds a readable description', () => {
    expect(bay('paid-for bay').description).toMatch(/^Paid-for bay · mon-sat 08:30-18:30 · max 2 hours$/);
  });

  it('the CPZ polygon contains the sample', () => {
    expect(realZone.code).toBe('CA-E');
    expect(realZone.hours).toBe('Mo-Fr 08:30-18:30, Sa 08:30-18:30');
    const inside = realBays.filter((b) => pointInPolygon(b.geometry[0]!, realZone.polygon)).length;
    expect(inside / realBays.length).toBeGreaterThan(0.8);
  });

  it('suspensions are attached by bay id', () => {
    const bays = (baysFixture as CamdenBayRow[]).map(bayFromRow).filter((b): b is CouncilBay => b !== null);
    applySuspensions(bays, suspensionsFixture as CamdenSuspensionRow[]);
    const rows = suspensionsFixture as CamdenSuspensionRow[];
    const suspendedIds = new Set(rows.filter((r) => r.suspension_status === 'Suspended').map((r) => r.space_identifier!.slice(0, -3)));
    expect(bays.filter((b) => b.suspension === 'suspended').length).toBe(bays.filter((b) => suspendedIds.has(b.id)).length);
  });
});

// ---- merging council data into kerbs ----

const ORIGIN: LatLon = { lat: 51.5, lon: -0.12 };
const at = (east: number, north: number): LatLon => ({
  lat: ORIGIN.lat + north / 111_320,
  lon: ORIGIN.lon + east / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180)),
});
const street: StreetWay = { id: 1, tags: { highway: 'residential', name: 'Test Road' }, geometry: [at(-100, 0), at(100, 0)], nodes: [1, 2] };

/** A 6 m bay drawn against the north kerb (5 m north of the centreline), centred `east` metres along. */
function bay(id: string, type: string, times: string, east: number, extra: Partial<CamdenBayRow> = {}): CouncilBay {
  const pts = [at(east - 3, 5), at(east - 3, 7), at(east + 3, 7), at(east + 3, 5)];
  return bayFromRow({
    unique_identifier: id,
    restriction_type: type,
    times_of_operation: times,
    maximum_stay: 'N/A',
    road_name: 'Test Road',
    parking_spaces: '1',
    parking_bay_length_metres: '6',
    epsg_4326_geojson_geometry: JSON.stringify({ type: 'LineString', coordinates: pts.map((p) => [p.lon, p.lat]) }),
    ...extra,
  })!;
}
const zone: CouncilZone = {
  code: 'T1',
  name: 'Test zone',
  council: 'test',
  hours: 'Mo-Fr 08:30-18:30',
  polygon: [[at(-500, -500), at(500, -500), at(500, 500), at(-500, 500)]],
};
const council = (bays: CouncilBay[], zones: CouncilZone[] = []): CouncilData => ({ councils: [{ id: 'test', name: 'Test', attribution: 'Test' }], bays, zones });

function search(c: CouncilData, start: Date, vehicle = hatch, now = start) {
  const data: ParkingData = { streets: [street], points: [], carParks: [], council: c };
  const opts: SearchOptions = { destination: ORIGIN, radiusM: 400, stay: { start, minutes: 60 }, vehicle, includeUnsurveyed: true };
  return evaluate(data, opts, now);
}

describe('council bays on kerbs', () => {
  it('a bay lands on the right kerb, over the right stretch', () => {
    const { places } = search(council([bay('B1', 'resident permit holders only', 'mon-fri 08:30-18:30', 0)]), mon(12));
    const b = places.find((p) => p.bay)!;
    expect(b.id.startsWith('w1:left')).toBe(true); // north side
    expect(lineLength(b.geometry)).toBeGreaterThan(5);
    expect(lineLength(b.geometry)).toBeLessThan(7.5);
    expect(b.assessment.status).toBe('permit');
    expect(b.tier).toBe('confirmed');
  });

  it('a residents bay is free outside its hours, a pay bay too', () => {
    const c = council([bay('B1', 'resident permit holders only', 'mon-fri 08:30-18:30', -50), bay('B2', 'paid-for', 'mon-sat 08:30-18:30', 50)]);
    const evening = search(c, mon(19)).results.filter((r) => r.bay);
    expect(evening.map((r) => r.bay!.id).sort()).toEqual(['B1', 'B2']);
    const daytime = search(c, mon(11)).results.filter((r) => r.bay);
    expect(daytime).toEqual([]);
  });

  it('disabled bays are never suggested', () => {
    const c = council([bay('B1', 'disabled (blue badge)', 'at any time', 0)]);
    expect(search(c, sun(12)).results.filter((r) => r.bay)).toEqual([]);
  });

  it('bays are authorised spaces: they override the junction cut-out', () => {
    const side: StreetWay = { id: 2, tags: { highway: 'residential' }, geometry: [at(0, 0), at(0, 150)], nodes: [3, 4] };
    const main: StreetWay = { ...street, geometry: [at(-100, 0), at(0, 0), at(100, 0)], nodes: [1, 3, 2] };
    const data: ParkingData = { streets: [main, side], points: [], carParks: [], council: council([bay('B1', 'paid-for', 'mon-sat 08:30-18:30', -12)]) };
    const { results } = evaluate(data, { destination: ORIGIN, radiusM: 400, stay: { start: mon(20), minutes: 60 }, vehicle: hatch, includeUnsurveyed: true });
    expect(results.some((r) => r.bay?.id === 'B1')).toBe(true);
  });

  it('bay space length limits the vehicle', () => {
    const c = council([bay('B1', 'paid-for', 'mon-sat 08:30-18:30', 0, { parking_bay_length_metres: '5.5' })]);
    expect(search(c, mon(20)).results.some((r) => r.bay)).toBe(true);
    expect(search(c, mon(20), bigVan).results.some((r) => r.bay)).toBe(false);
  });

  it('live suspensions apply on the day only', () => {
    const b = bay('B1', 'paid-for', 'mon-sat 08:30-18:30', 0);
    b.suspension = 'suspended';
    const today = search(council([b]), mon(20), hatch, mon(9));
    expect(today.places.find((p) => p.bay)!.assessment.status).toBe('restricted');
    const otherDay = search(council([b]), mon(20), hatch, sun(9));
    expect(otherDay.results.some((r) => r.bay)).toBe(true);
    expect(otherDay.results.find((r) => r.bay)!.assessment.reasons.join(' ')).toContain('Suspended at the moment');
  });

  it('bays with no kerb nearby are shown on their own', () => {
    const far = bay('B9', 'paid-for', 'mon-sat 08:30-18:30', 0);
    far.geometry = far.geometry.map((p) => ({ lat: p.lat + 0.001, lon: p.lon })); // ~110 m north, no street
    const { places } = search(council([far]), mon(20));
    const p = places.find((x) => x.bay?.id === 'B9')!;
    expect(p.id).toBe('ccamden:B9');
    expect(p.osmUrl).toBeUndefined();
  });
});

describe('controlled parking zones on unsurveyed kerbs', () => {
  it('kerbs are single yellow during zone hours', () => {
    const { results, places } = search(council([], [zone]), mon(11));
    expect(results.filter((r) => r.id.startsWith('w1:'))).toEqual([]);
    expect(places.find((p) => p.id.startsWith('w1:'))!.assessment.reasons[0]).toContain('Controlled zone T1');
  });

  it('and free outside them, still unsurveyed and with a double-yellow warning', () => {
    const { results } = search(council([], [zone]), mon(19));
    const r = results.find((x) => x.id.startsWith('w1:'))!;
    expect(r.tier).toBe('unsurveyed');
    expect(r.zone).toBe('T1');
    expect(r.assessment.reasons.join(' ')).toContain('double yellow');
  });

  it('a stay that runs into zone hours is not free', () => {
    const data: ParkingData = { streets: [street], points: [], carParks: [], council: council([], [zone]) };
    const { results } = evaluate(data, { destination: ORIGIN, radiusM: 400, stay: { start: mon(7), minutes: 120 }, vehicle: hatch, includeUnsurveyed: true });
    expect(results.filter((r) => r.id.startsWith('w1:'))).toEqual([]);
  });

  it('a street crossing the zone boundary is split at the boundary', () => {
    // Zone covers only the eastern half of the street (east of x = 0).
    const half: CouncilZone = { ...zone, polygon: [[at(0, -500), at(500, -500), at(500, 500), at(0, 500)]] };
    const { results, places } = search(council([], [half]), mon(11));
    const free = results.filter((r) => r.id.startsWith('w1:left'));
    const len = free.reduce((n, r) => n + lineLength(r.geometry), 0);
    expect(len).toBeGreaterThan(90);
    expect(len).toBeLessThan(110); // only the western ~100 m
    expect(places.some((p) => p.id.startsWith('w1:left') && p.zone === 'T1' && p.assessment.status === 'restricted')).toBe(true);
  });

  it('a mapped kerb keeps its own rules', () => {
    const mapped: StreetWay = { ...street, tags: { ...street.tags, 'parking:both': 'lane', 'parking:both:fee': 'no' } };
    const data: ParkingData = { streets: [mapped], points: [], carParks: [], council: council([], [zone]) };
    const { results } = evaluate(data, { destination: ORIGIN, radiusM: 400, stay: { start: mon(11), minutes: 60 }, vehicle: hatch, includeUnsurveyed: true });
    expect(results.some((r) => r.id.startsWith('w1:'))).toBe(true);
  });

  it('a single yellow seen from the air follows the zone hours', () => {
    const data = (): ParkingData => ({
      streets: [street],
      points: [],
      carParks: [],
      council: council([], [zone]),
      markings: [
        { marking: 'single_yellow', geometry: [at(-100, 5), at(100, 5)], confidence: 0.9, imageDate: '2025-06-14', source: 't' },
      ],
    });
    const run = (start: Date) =>
      evaluate(data(), { destination: ORIGIN, radiusM: 400, stay: { start, minutes: 60 }, vehicle: hatch, includeUnsurveyed: true }).results.filter((r) =>
        r.id.startsWith('w1:left'),
      );
    expect(run(mon(11))).toEqual([]);
    const evening = run(mon(19));
    expect(evening.length).toBeGreaterThan(0);
    expect(evening[0]!.tier).toBe('checked');
  });
});

describe('real data end to end', () => {
  it('on a weekday evening, Fitzrovia pay and residents bays become free', () => {
    const c: CouncilData = { councils: [{ id: 'camden', name: 'Camden', attribution: '' }], bays: realBays, zones: [realZone] };
    const destination = { lat: 51.5237, lon: -0.1401 };
    const run = (start: Date) =>
      evaluate({ streets: [], points: [], carParks: [], council: c }, { destination, radiusM: 200, stay: { start, minutes: 60 }, vehicle: hatch, includeUnsurveyed: true }, sun(0));
    const day = run(mon(11)).results.length;
    const evening = run(mon(20)).results;
    expect(evening.length).toBeGreaterThan(day);
    expect(evening.every((r) => r.tier === 'confirmed' || r.tier === 'partial')).toBe(true);
    // Disabled, EV and motorcycle bays are never offered.
    expect(evening.some((r) => /disabled|motorcycle|electric|ev charging/i.test(r.bay!.description))).toBe(false);
  });
});
