import type { LatLon, ParkingData, PointFeature, StreetWay } from '../data/overpass';
import type { Tags } from '../rules/engine';
import { distanceM } from '../geo/measure';

/**
 * A place near which you can't park, derived from UK national rules (mostly the
 * Highway Code) and the road layout in OpenStreetMap. These apply everywhere,
 * whether or not anyone has mapped the local parking rules.
 *
 * A zone removes the part of a kerb within `radius` metres of `center`, but
 * only for kerbs passing within `near` metres of it, so a bus stop on one
 * pavement doesn't cut the kerb on the other side of the road.
 */
export interface Zone {
  center: LatLon;
  radius: number;
  near: number;
  reason: string;
  /**
   * Whether the zone also cuts kerbs whose parking is explicitly mapped.
   * Junction distances don't apply to authorised (mapped, marked) spaces.
   */
  appliesToMapped: boolean;
}

/** Service roads that aren't streets: driveways, car-park aisles, drive-throughs. */
export function isMinorService(tags: Tags): boolean {
  return tags['highway'] === 'service' && ['driveway', 'parking_aisle', 'drive-through'].includes(tags['service'] ?? '');
}

const ZIGZAG_REFS = /^(zebra|pelican|puffin|toucan|pegasus|tiger|equestrian)$/;

/** Controlled crossings (zebra, pelican, puffin, toucan…) have zig-zag lines; uncontrolled ones don't. */
export function hasZigzags(t: Tags): boolean {
  if (t['highway'] !== 'crossing' && t['crossing'] === undefined) return false;
  if (t['crossing'] === 'traffic_signals' || t['crossing'] === 'zebra') return true;
  if (t['crossing:signals'] === 'yes') return true;
  if (ZIGZAG_REFS.test(t['crossing_ref'] ?? '')) return true;
  return (t['crossing:markings'] ?? '').startsWith('zebra');
}

function pointZone(p: PointFeature): Zone | null {
  const t = p.tags;
  const center = { lat: p.lat, lon: p.lon };
  if (hasZigzags(t)) {
    return { center, radius: 18, near: 8, appliesToMapped: true, reason: 'Pedestrian crossing zig-zags: you must not stop (Highway Code 240)' };
  }
  if (t['railway'] === 'level_crossing') {
    return { center, radius: 30, near: 10, appliesToMapped: true, reason: 'Level crossing approach (Highway Code 243 and 291)' };
  }
  if (t['highway'] === 'bus_stop') {
    return { center, radius: 15, near: 10, appliesToMapped: true, reason: 'Bus stop, often a no-stopping clearway (Highway Code 243)' };
  }
  if (t['amenity'] === 'taxi') {
    return { center, radius: 12, near: 10, appliesToMapped: true, reason: 'Taxi rank (Highway Code 240)' };
  }
  if (t['traffic_calming'] === 'island' || t['crossing:island'] === 'yes') {
    return { center, radius: 8, near: 8, appliesToMapped: false, reason: 'Opposite a traffic island (Highway Code 243)' };
  }
  if (t['kerb'] === 'lowered' || t['kerb'] === 'flush') {
    return { center, radius: 3, near: 5, appliesToMapped: true, reason: 'Dropped kerb (Highway Code 243)' };
  }
  return null;
}

/**
 * Junctions: a node where three or more road "arms" meet. A node in the middle of
 * a way is two arms; the end of a way is one. Two ways joined end to end (a way
 * split for tagging) are therefore not a junction.
 */
function junctionZones(streets: StreetWay[]): Zone[] {
  const arms = new Map<number, { main: number; all: number; at: LatLon }>();
  for (const w of streets) {
    if (!w.nodes || isMinorService(w.tags) || w.tags['area'] === 'yes') continue;
    const main = w.tags['highway'] !== 'service';
    w.nodes.forEach((id, i) => {
      const n = i === 0 || i === w.nodes!.length - 1 ? 1 : 2;
      const a = arms.get(id) ?? { main: 0, all: 0, at: w.geometry[i]! };
      a.all += n;
      if (main) a.main += n;
      arms.set(id, a);
    });
  }
  const zones: Zone[] = [];
  for (const a of arms.values()) {
    if (a.main >= 3) {
      // 10 m from the junction, plus about half the side road's width.
      zones.push({ center: a.at, radius: 14, near: 14, appliesToMapped: false, reason: 'Within 10 m of a junction (Highway Code 243)' });
    } else if (a.all >= 3) {
      zones.push({ center: a.at, radius: 7, near: 7, appliesToMapped: false, reason: 'Entrance to a lane or access road (Highway Code 243)' });
    }
  }
  return zones;
}

/** Driveways: keep clear of the dropped kerb where a driveway meets the street. */
function drivewayZones(streets: StreetWay[]): Zone[] {
  const streetNodes = new Set<number>();
  for (const w of streets) if (!isMinorService(w.tags)) w.nodes?.forEach((n) => streetNodes.add(n));

  const zones: Zone[] = [];
  for (const w of streets) {
    if (w.tags['service'] !== 'driveway' || !w.nodes || w.geometry.length < 2) continue;
    const ends: [number, number][] = [
      [0, 1],
      [w.nodes.length - 1, w.nodes.length - 2],
    ];
    for (const [end, next] of ends) {
      if (!streetNodes.has(w.nodes[end]!)) continue;
      // Move 4 m from the street centreline towards the driveway, onto that side's kerb.
      const a = w.geometry[end]!;
      const b = w.geometry[next]!;
      const d = distanceM(a, b) || 1;
      const f = Math.min(1, 4 / d);
      const center = { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
      zones.push({ center, radius: 3.5, near: 3, appliesToMapped: true, reason: 'Driveway: do not block the dropped kerb (Highway Code 243)' });
    }
  }
  return zones;
}

export function buildZones(data: ParkingData): Zone[] {
  const zones = [...junctionZones(data.streets), ...drivewayZones(data.streets)];
  for (const p of data.points) {
    const z = pointZone(p);
    if (z) zones.push(z);
  }
  return zones;
}
