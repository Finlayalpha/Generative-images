import type { ParkingData, StreetWay } from './overpass';
import type { Tags } from '../rules/engine';

/**
 * Synthetic demo data (not a real place) so the app can be tried without
 * network access to Overpass: open the app with `?demo`.
 */
export const DEMO_CENTER = { lat: 51.5, lon: -0.12 };

const SCENARIOS: Tags[] = [
  { name: 'Free Street', 'parking:both': 'lane', 'parking:both:fee': 'no' },
  {
    name: 'Meter Road',
    'parking:both': 'lane',
    'parking:both:fee': 'no',
    'parking:both:fee:conditional': 'yes @ (Mo-Sa 08:00-18:30)',
    'parking:both:maxstay:conditional': '4 hours @ (Mo-Sa 08:00-18:30)',
  },
  {
    name: 'Clearway Avenue',
    'parking:right': 'lane',
    'parking:right:fee': 'no',
    'parking:right:restriction:conditional': 'no_stopping @ (Mo-Fr 07:00-10:00,16:00-19:00)',
    'parking:left': 'no',
    'parking:left:restriction': 'no_stopping',
  },
  {
    name: 'Residents Close',
    'parking:both': 'lane',
    'parking:both:access': 'yes',
    'parking:both:access:conditional': 'private @ (Mo-Fr 08:30-18:30)',
    'parking:both:zone': 'B',
  },
  {
    name: 'Disc Lane',
    'parking:both': 'half_on_kerb',
    'parking:both:fee': 'no',
    'parking:both:maxstay:conditional': '2 hours @ (Mo-Sa 09:00-18:00)',
    'parking:both:authentication:disc': 'yes',
  },
  { name: 'Old Scheme Street', 'parking:lane:both': 'parallel', 'parking:condition:both': 'free' },
  { name: 'Unmapped Road' },
];

function grid(): StreetWay[] {
  const ways: StreetWay[] = [];
  const step = 0.0018;
  let id = 1;
  for (let r = 0; r < 4; r++) {
    const lat = DEMO_CENTER.lat - step * 1.5 + r * step;
    ways.push({
      id: id++,
      tags: { highway: 'residential', ...SCENARIOS[(r * 2) % SCENARIOS.length]! },
      geometry: [-2, -1, 0, 1, 2].map((k) => ({ lat, lon: DEMO_CENTER.lon + k * step * 1.4 })),
    });
  }
  for (let c = 0; c < 5; c++) {
    const lon = DEMO_CENTER.lon - step * 2.8 + c * step * 1.4;
    ways.push({
      id: id++,
      tags: { highway: 'residential', ...SCENARIOS[(c * 2 + 1) % SCENARIOS.length]! },
      geometry: [-1.5, -0.5, 0.5, 1.5].map((k) => ({ lat: DEMO_CENTER.lat + k * step, lon })),
    });
  }
  return ways;
}

export const DEMO_DATA: ParkingData = {
  streets: grid(),
  carParks: [
    { id: 100, type: 'node', center: { lat: 51.5009, lon: -0.1225 }, tags: { amenity: 'parking', name: 'Free car park', fee: 'no', access: 'yes', capacity: '40', opening_hours: '06:00-22:00' } },
    { id: 101, type: 'node', center: { lat: 51.4991, lon: -0.1175 }, tags: { amenity: 'parking', name: 'Supermarket', access: 'customers', maxstay: '2 hours' } },
    { id: 102, type: 'node', center: { lat: 51.5009, lon: -0.1175 }, tags: { amenity: 'parking', name: 'Pay car park', fee: 'yes' } },
  ],
};
