import type { CarPark, LatLon, ParkingData, PointFeature, StreetWay } from './overpass';
import type { KerbMarking, MarkingType } from './markings';
import type { Tags } from '../rules/engine';
import { offsetLine } from '../geo/offset';
import { lineLength, sliceLine } from '../geo/measure';
import { bayFromRow } from '../councils/camden';
import type { CouncilBay, CouncilData } from '../councils/types';

/**
 * Synthetic demo town (not a real place) so the app can be tried without
 * network access: open the app with `?demo`. Street names are generic.
 */
export const DEMO_CENTER: LatLon = { lat: 51.5, lon: -0.12 };

const STEP_LAT = 0.0018; // ~200 m
const STEP_LON = 0.0025; // ~175 m

const node = (r: number, c: number): LatLon => ({
  lat: DEMO_CENTER.lat + (1.5 - r) * STEP_LAT,
  lon: DEMO_CENTER.lon + (c - 2) * STEP_LON,
});
const nodeId = (r: number, c: number) => 1000 + r * 10 + c;
const mid = (a: LatLon, b: LatLon, t = 0.5): LatLon => ({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });

// East–west streets, top to bottom.
const ROWS: Tags[] = [
  { name: 'Station Road', highway: 'secondary', maxspeed: '30 mph' },
  { name: 'Church Lane', highway: 'residential' },
  {
    name: 'Mill Street',
    highway: 'residential',
    'parking:both': 'lane',
    'parking:both:markings': 'yes',
    'parking:both:fee': 'no',
    'parking:both:fee:conditional': 'yes @ (Mo-Sa 08:00-18:30)',
  },
  { name: 'Park Avenue', highway: 'residential', 'parking:both': 'lane', 'parking:both:fee': 'no' },
];

// North–south streets, left to right.
const COLS: Tags[] = [
  { name: 'Victoria Road', highway: 'primary', 'cycleway:left': 'lane', 'cycleway:left:lane': 'exclusive' },
  {
    name: 'Queen Street',
    highway: 'residential',
    'parking:both': 'lane',
    'parking:both:access': 'yes',
    'parking:both:access:conditional': 'private @ (Mo-Fr 08:30-18:30)',
    'parking:both:zone': 'B',
  },
  {
    name: 'High Street',
    highway: 'tertiary',
    'parking:left': 'no',
    'parking:left:restriction': 'no_stopping',
    'parking:right': 'lane',
    'parking:right:fee': 'no',
    'parking:right:maxstay:conditional': '2 hours @ (Mo-Sa 09:00-18:00)',
    'parking:right:restriction:conditional': 'no_stopping @ (Mo-Fr 07:30-09:30,16:30-18:30)',
  },
  { name: 'Elm Grove', highway: 'residential', maxheight: '2.2' },
  { name: 'Bridge Street', highway: 'unclassified', overtaking: 'no' },
];

function streets(): StreetWay[] {
  const ways: StreetWay[] = [];
  ROWS.forEach((tags, r) => {
    const cols = [0, 1, 2, 3, 4];
    const geometry: LatLon[] = [];
    const nodes: number[] = [];
    for (const c of cols) {
      geometry.push(node(r, c));
      nodes.push(nodeId(r, c));
      // Church Lane: an extra node where a driveway joins.
      if (r === 1 && c === 2) {
        geometry.push(mid(node(r, 2), node(r, 3), 0.4));
        nodes.push(2000);
      }
    }
    ways.push({ id: 100 + r, tags, geometry, nodes });
  });
  COLS.forEach((tags, c) => {
    ways.push({
      id: 200 + c,
      tags,
      geometry: [0, 1, 2, 3].map((r) => node(r, c)),
      nodes: [0, 1, 2, 3].map((r) => nodeId(r, c)),
    });
  });
  // A driveway off the south side of Church Lane.
  const dj = mid(node(1, 2), node(1, 3), 0.4);
  ways.push({
    id: 300,
    tags: { highway: 'service', service: 'driveway' },
    geometry: [dj, { lat: dj.lat - 0.00018, lon: dj.lon }],
    nodes: [2000, 2001],
  });
  return ways;
}

const POINTS: PointFeature[] = [
  // Zebra crossing on Station Road.
  { id: 1, ...mid(node(0, 1), node(0, 2)), tags: { highway: 'crossing', crossing: 'uncontrolled', crossing_ref: 'zebra' } },
  // Bus stop on the north pavement of Station Road.
  { id: 2, lat: node(0, 3).lat + 0.00003, lon: mid(node(0, 3), node(0, 4), 0.3).lon, tags: { highway: 'bus_stop' } },
];

const CAR_PARKS: CarPark[] = [
  {
    id: 400,
    type: 'way',
    center: { lat: DEMO_CENTER.lat + 0.0009, lon: DEMO_CENTER.lon - 0.0037 },
    tags: { amenity: 'parking', name: 'Leisure Centre', parking: 'surface', fee: 'no', access: 'yes', opening_hours: '06:00-22:00' },
  },
  {
    id: 401,
    type: 'way',
    center: { lat: DEMO_CENTER.lat - 0.0009, lon: DEMO_CENTER.lon + 0.0012 },
    tags: { amenity: 'parking', name: 'Market multi-storey', parking: 'multi-storey', fee: 'no', maxheight: '1.9' },
  },
  {
    id: 402,
    type: 'way',
    center: { lat: DEMO_CENTER.lat + 0.0009, lon: DEMO_CENTER.lon + 0.0037 },
    tags: { amenity: 'parking', name: 'Supermarket', access: 'customers', maxstay: '2 hours' },
  },
];

/**
 * Synthetic aerial-imagery observations: as if a survey photo from June 2025
 * had been run through the marking detector.
 */
function markings(ways: StreetWay[]): KerbMarking[] {
  const byId = new Map(ways.map((w) => [w.id, w]));
  const obs = (
    wayId: number,
    side: 'left' | 'right',
    marking: MarkingType,
    from: number,
    to: number,
    extra: Partial<KerbMarking> = {},
  ): KerbMarking => {
    // Real kerbs aren't exactly where we assume: put the observation 1 m further out.
    const kerb = offsetLine(byId.get(wayId)!.geometry, side === 'right' ? 5 : -5);
    const len = lineLength(kerb);
    return {
      marking,
      geometry: sliceLine(kerb, Math.max(0, from), Math.min(len, to)),
      confidence: 0.9,
      imageDate: '2025-06-14',
      source: 'demo-survey-2025',
      ...extra,
    };
  };
  return [
    // Church Lane (id 101, west→east; left = north side): double yellows on the western end.
    obs(101, 'left', 'double_yellow', 0, 260),
    // …and no lines on the south side, with cars parked.
    obs(101, 'right', 'clear', 0, 1000, { parkedVehicles: true }),
    // Station Road (id 100): single yellow along the south side.
    obs(100, 'right', 'single_yellow', 0, 1000, { confidence: 0.85 }),
    // Elm Grove (id 203, north→south): no lines either side.
    obs(203, 'left', 'clear', 0, 1000, { parkedVehicles: true }),
    obs(203, 'right', 'clear', 0, 1000),
    // Victoria Road (id 200, north→south; right = west side): marked bays, rules unknown.
    obs(200, 'right', 'bay', 150, 450, { confidence: 0.8 }),
    // Park Avenue (id 103, mapped as free): the photo shows double yellows on part of it.
    obs(103, 'left', 'double_yellow', 420, 500),
  ];
}

/**
 * Synthetic council data, in the same shape a real council adapter produces:
 * a controlled zone over the east of town, and bays on Church Lane.
 */
function council(): CouncilData {
  const north = (p: LatLon, m: number): LatLon => ({ lat: p.lat + m / 111_320, lon: p.lon });
  const bay = (id: string, type: string, times: string, t0: number, t1: number, maxStay = 'N/A'): CouncilBay => {
    // Drawn against the north kerb of Church Lane, between Elm Grove's and Bridge Street's junctions.
    const a = mid(node(1, 3), node(1, 4), t0);
    const b = mid(node(1, 3), node(1, 4), t1);
    const pts = [north(a, 5), north(a, 7), north(b, 7), north(b, 5)];
    const spaces = Math.max(1, Math.round((t1 - t0) * 175 / 5.5));
    const row = bayFromRow({
      unique_identifier: id,
      restriction_type: type,
      times_of_operation: times,
      maximum_stay: maxStay,
      road_name: 'Church Lane',
      controlled_parking_zone: 'Z-E',
      parking_spaces: String(spaces),
      parking_bay_length_metres: String(Math.round((t1 - t0) * 175)),
      epsg_4326_geojson_geometry: JSON.stringify({ type: 'LineString', coordinates: pts.map((p) => [p.lon, p.lat]) }),
    })!;
    return { ...row, council: 'demo' };
  };
  const west = node(0, 2).lon + 0.0006;
  const east = node(0, 4).lon + 0.003;
  const top = node(0, 0).lat + 0.002;
  const bottom = node(3, 0).lat - 0.002;
  return {
    councils: [{ id: 'demo', name: 'Demo council', attribution: 'Synthetic demo council data' }],
    zones: [
      {
        code: 'Z-E',
        name: 'Demo East zone',
        council: 'demo',
        hours: 'Mo-Fr 08:30-18:30, Sa 08:30-13:30',
        polygon: [[{ lat: top, lon: west }, { lat: top, lon: east }, { lat: bottom, lon: east }, { lat: bottom, lon: west }]],
      },
    ],
    bays: [
      bay('D1', 'resident permit holders only', 'mon-fri 08:30-18:30', 0.15, 0.4),
      bay('D2', 'paid-for', 'mon-sat 08:30-18:30', 0.45, 0.6, '4 hours'),
      bay('D3', 'disabled (blue badge)', 'at any time', 0.62, 0.68),
    ],
  };
}

const STREETS = streets();
export const DEMO_DATA: ParkingData = {
  streets: STREETS,
  points: POINTS,
  carParks: CAR_PARKS,
  markings: markings(STREETS),
  council: council(),
};
