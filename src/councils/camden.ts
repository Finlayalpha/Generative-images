import type { LatLon } from '../data/overpass';
import type { Tags } from '../rules/engine';
import { toOpeningHours } from './times';
import type { CouncilBay, CouncilData, CouncilInfo, CouncilZone } from './types';

/**
 * London Borough of Camden open data (Socrata), Open Government Licence v3.
 *   Parking bays           7hiv-3r9k  (updated daily)
 *   Controlled zones       vf6e-iymu
 *   Bay suspensions        av3b-8trg  (live)
 */
export const CAMDEN: CouncilInfo = {
  id: 'camden',
  name: 'London Borough of Camden',
  attribution: 'Contains public sector information from the London Borough of Camden, licensed under the Open Government Licence v3.0',
};

const API = 'https://opendata.camden.gov.uk/resource';

/** Rough borough extent, used to decide whether to ask Camden at all. */
export const CAMDEN_BBOX = { south: 51.509, west: -0.215, north: 51.574, east: -0.104 };

export interface CamdenBayRow {
  unique_identifier: string;
  restriction_type?: string;
  times_of_operation?: string;
  maximum_stay?: string;
  road_name?: string;
  controlled_parking_zone?: string;
  parking_spaces?: string;
  parking_bay_length_metres?: string;
  tariff?: string;
  epsg_4326_geojson_geometry?: string;
}

export interface CamdenZoneRow {
  sub_zone_name?: string;
  controlled_parking_zone_name?: string;
  control_monday_to_friday?: string;
  control_saturday?: string;
  location?: { type: string; coordinates: number[][][] | number[][][][] };
}

export interface CamdenSuspensionRow {
  space_identifier?: string;
  suspension_status?: string;
}

/** What a bay type means for an ordinary car, during the bay's hours. */
type BayEffect =
  | { kind: 'paid' }
  | { kind: 'free' }
  | { kind: 'access'; value: string } // permit holders, residents, car club, doctors, …
  | { kind: 'restriction'; value: string; always?: boolean }; // disabled, loading, EV, not for cars

export function bayEffect(restrictionType: string): BayEffect {
  const t = restrictionType.toLowerCase();
  // Bays never usable by cars, whatever the time.
  if (/solo motorcycles|bicycles|bike hire|cycle hire|\bbuses\b/.test(t)) return { kind: 'restriction', value: 'no_parking', always: true };
  if (t.includes('taxi')) return { kind: 'restriction', value: 'no_parking' };
  if (t.includes('loading')) return { kind: 'restriction', value: 'loading_only' };
  if (t.includes('disabled')) return { kind: 'restriction', value: 'disabled_only' };
  if (t.includes('ev charging') || t.includes('electric vehicle')) return { kind: 'restriction', value: 'charging_only' };
  // Shared-use bays: anyone can park by paying.
  if (t.includes('paid-for')) return { kind: 'paid' };
  if (t === 'free') return { kind: 'free' };
  return { kind: 'access', value: 'private' };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Turn one Camden bay row into engine tags plus a description. */
export function bayFromRow(row: CamdenBayRow): CouncilBay | null {
  let geometry: LatLon[] = [];
  try {
    const g = JSON.parse(row.epsg_4326_geojson_geometry ?? 'null') as { type: string; coordinates: number[][] | number[][][] } | null;
    const lines = g?.type === 'MultiLineString' ? (g.coordinates as number[][][]) : g?.type === 'LineString' ? [g.coordinates as number[][]] : [];
    geometry = lines.flat().map(([lon, lat]) => ({ lat: lat!, lon: lon! }));
  } catch {
    return null;
  }
  if (geometry.length < 2) return null;

  const rt = row.restriction_type ?? 'unknown';
  const parsed = toOpeningHours(row.times_of_operation);
  const hours = parsed ?? '24/7';
  const effect = bayEffect(rt);
  const maxstay = row.maximum_stay && row.maximum_stay !== 'N/A' ? row.maximum_stay : undefined;

  // Outside the bay's hours it's an ordinary free kerb (no yellow line inside a bay).
  const tags: Tags = { fee: 'no' };
  switch (effect.kind) {
    case 'paid':
      tags['fee:conditional'] = `yes @ (${hours})`;
      break;
    case 'free':
      break;
    case 'access':
      tags['access'] = 'yes';
      tags['access:conditional'] = `${effect.value} @ (${hours})`;
      break;
    case 'restriction':
      if (effect.always) tags['restriction'] = effect.value;
      else tags['restriction:conditional'] = `${effect.value} @ (${hours})`;
      break;
  }
  if (maxstay && (effect.kind === 'paid' || effect.kind === 'free')) tags['maxstay:conditional'] = `${maxstay} @ (${hours})`;

  const when = row.times_of_operation ? row.times_of_operation.replace(/\s+/g, ' ') : 'times unknown';
  const description = [`${cap(rt)} bay`, when, maxstay ? `max ${maxstay}` : null].filter(Boolean).join(' · ');

  return {
    id: row.unique_identifier,
    council: CAMDEN.id,
    geometry,
    tags,
    description,
    road: row.road_name,
    zone: row.controlled_parking_zone,
    spaces: row.parking_spaces ? Number(row.parking_spaces) || undefined : undefined,
    lengthM: row.parking_bay_length_metres ? Number(row.parking_bay_length_metres) || undefined : undefined,
    uncertain: parsed === null || undefined,
  };
}

/** Camden zones list control hours for Monday–Friday and Saturday; Sundays are uncontrolled. */
export function zoneFromRow(row: CamdenZoneRow): CouncilZone | null {
  const g = row.location;
  if (!g) return null;
  const rings: number[][][] = g.type === 'MultiPolygon' ? (g.coordinates as number[][][][]).flat() : (g.coordinates as number[][][]);
  const polygon = rings.map((ring) => ring.map(([lon, lat]) => ({ lat: lat!, lon: lon! })));
  if (!polygon.length || polygon[0]!.length < 3) return null;

  const part = (days: string, t?: string) => (t && /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(t.trim()) ? toOpeningHours(`${days} ${t}`) : null);
  const hours = [part('mon-fri', row.control_monday_to_friday), part('sat', row.control_saturday)].filter(Boolean).join(', ') || null;

  return {
    code: row.sub_zone_name ?? row.controlled_parking_zone_name ?? 'CPZ',
    name: row.controlled_parking_zone_name ?? row.sub_zone_name ?? 'Controlled parking zone',
    council: CAMDEN.id,
    hours,
    polygon,
  };
}

/** Mark bays with live suspension status (space ids are the bay id plus a 3-digit space number). */
export function applySuspensions(bays: CouncilBay[], rows: CamdenSuspensionRow[]): void {
  const status = new Map<string, 'suspended' | 'planned'>();
  for (const r of rows) {
    const bay = r.space_identifier?.slice(0, -3);
    if (!bay) continue;
    if (r.suspension_status === 'Suspended') status.set(bay, 'suspended');
    else if (r.suspension_status?.includes('future') && status.get(bay) !== 'suspended') status.set(bay, 'planned');
  }
  for (const b of bays) {
    const s = status.get(b.id);
    if (s) b.suspension = s;
  }
}

export function inCamden(c: LatLon, radiusM: number): boolean {
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.cos((c.lat * Math.PI) / 180));
  const b = CAMDEN_BBOX;
  return c.lat + dLat >= b.south && c.lat - dLat <= b.north && c.lon + dLon >= b.west && c.lon - dLon <= b.east;
}

async function soql<T>(dataset: string, params: Record<string, string>, signal?: AbortSignal): Promise<T[]> {
  const res = await fetch(`${API}/${dataset}.json?${new URLSearchParams(params)}`, { signal });
  if (!res.ok) throw new Error(`Camden ${dataset} ${res.status}`);
  return (await res.json()) as T[];
}

/** Fetch bays (with live suspensions) and zones around a point. */
export async function fetchCamden(c: LatLon, radiusM: number, signal?: AbortSignal): Promise<CouncilData> {
  const circle = (field: string) => `within_circle(${field}, ${c.lat.toFixed(6)}, ${c.lon.toFixed(6)}, ${Math.round(radiusM + 50)})`;
  const [bayRows, zoneRows, suspensionRows] = await Promise.all([
    soql<CamdenBayRow>('7hiv-3r9k', { $where: circle('location'), $limit: '5000' }, signal),
    soql<CamdenZoneRow>('vf6e-iymu', { $limit: '200' }, signal),
    soql<CamdenSuspensionRow>(
      'av3b-8trg',
      { $where: `${circle('location_point')} AND suspension_status != 'Available'`, $select: 'space_identifier,suspension_status', $limit: '5000' },
      signal,
    ).catch(() => []), // suspensions are a bonus
  ]);
  const bays = bayRows.map(bayFromRow).filter((b): b is CouncilBay => b !== null);
  applySuspensions(bays, suspensionRows);
  const zones = zoneRows.map(zoneFromRow).filter((z): z is CouncilZone => z !== null);
  return { councils: [CAMDEN], bays, zones };
}
