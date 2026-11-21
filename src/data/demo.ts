import type { CarPark, LatLon, ParkingData, PointFeature, StreetWay } from './overpass';
import type { Tags } from '../rules/engine';

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

export const DEMO_DATA: ParkingData = { streets: streets(), points: POINTS, carParks: CAR_PARKS };
