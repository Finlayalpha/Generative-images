import type { CouncilBay, CouncilZone } from '../councils/types';
import type { LatLon } from '../data/overpass';
import { midpoint, pointInPolygon, projectOnLine } from '../geo/measure';
import { assessCarPark, type Assessment, type StayWindow } from '../rules/engine';
import type { Fit, Vehicle } from '../vehicle';

/** A bay belongs to the nearest kerb line within this distance (m) of its centre. */
export const BAY_MATCH_M = 8;

export interface BayOnKerb {
  bay: CouncilBay;
  /** Extent along the kerb line (m). */
  from: number;
  to: number;
}

function centroid(line: LatLon[]): LatLon {
  const n = line.length;
  return { lat: line.reduce((s, p) => s + p.lat, 0) / n, lon: line.reduce((s, p) => s + p.lon, 0) / n };
}

/**
 * Conflate council bays onto our kerb lines: each bay goes to the nearest kerb
 * (so the correct side of the street), and covers the stretch its outline
 * projects onto. Bays with no kerb nearby are returned separately.
 */
export function assignBays(kerbs: { key: string; line: LatLon[] }[], bays: CouncilBay[]): { byKerb: Map<string, BayOnKerb[]>; unmatched: CouncilBay[] } {
  const byKerb = new Map<string, BayOnKerb[]>();
  const unmatched: CouncilBay[] = [];
  const pad = BAY_MATCH_M / 111_320;
  const boxed = kerbs.map((k) => {
    const lats = k.line.map((p) => p.lat);
    const lons = k.line.map((p) => p.lon);
    const padLon = pad / Math.cos(((lats[0] ?? 0) * Math.PI) / 180);
    return { ...k, s: Math.min(...lats) - pad, n: Math.max(...lats) + pad, w: Math.min(...lons) - padLon, e: Math.max(...lons) + padLon };
  });

  for (const bay of bays) {
    const c = centroid(bay.geometry);
    let best: { key: string; line: LatLon[]; distance: number } | null = null;
    for (const k of boxed) {
      if (c.lat < k.s || c.lat > k.n || c.lon < k.w || c.lon > k.e) continue;
      const { distance } = projectOnLine(k.line, c);
      if (distance <= BAY_MATCH_M && (!best || distance < best.distance)) best = { key: k.key, line: k.line, distance };
    }
    if (!best) {
      unmatched.push(bay);
      continue;
    }
    const along = bay.geometry.map((p) => projectOnLine(best!.line, p).along);
    const entry = { bay, from: Math.min(...along), to: Math.max(...along) };
    if (entry.to - entry.from < 1) continue; // degenerate projection (e.g. bay across the kerb end)
    const list = byKerb.get(best.key) ?? [];
    list.push(entry);
    byKerb.set(best.key, list);
  }
  return { byKerb, unmatched };
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** What a council bay means for this stay. `now` decides whether live suspensions apply. */
export function bayAssessment(bay: CouncilBay, stay: StayWindow, now = new Date()): Assessment {
  const a = assessCarPark(bay.tags, stay);
  const reasons = [bay.description, ...a.reasons];
  let { status, confidence } = a;
  if (bay.uncertain) {
    reasons.push("Couldn't read the bay's hours: assumed to apply at all times");
    confidence = 'medium';
  }
  if (bay.suspension === 'suspended') {
    if (sameDay(stay.start, now)) {
      status = 'restricted';
      reasons.unshift('Suspended today (live council data)');
    } else {
      reasons.push('Suspended at the moment: check the signs for dates');
    }
  } else if (bay.suspension === 'planned') {
    reasons.push('A suspension is planned here: check the signs for dates');
  }
  return { ...a, status, confidence, reasons };
}

/** Does the vehicle fit the bay's individual spaces? */
export function bayFit(bay: CouncilBay, v: Vehicle): Fit {
  if (!bay.lengthM || !bay.spaces) return { verdict: 'fits', notes: [] };
  const space = bay.lengthM / bay.spaces;
  if (v.length > space) return { verdict: 'too_big', notes: [`Spaces in this bay are about ${space.toFixed(1)} m long`] };
  if (v.length > space - 0.4) return { verdict: 'check', notes: [`Tight: spaces are about ${space.toFixed(1)} m long`] };
  return { verdict: 'fits', notes: [] };
}

/**
 * Which controlled zone (with known hours) each point of a kerb is in.
 * Returns a lookup giving the zone's index in `zones`, or -1. When the whole
 * kerb is in one zone (the usual case) it avoids testing every point.
 */
export function zoneLookup(line: LatLon[], zones: CouncilZone[]): (p: LatLon) => number {
  const candidates = zones
    .map((z, i) => ({ z, i }))
    .filter(({ z }) => {
      if (!z.hours) return false;
      const ring = z.polygon[0] ?? [];
      const s = Math.min(...ring.map((p) => p.lat));
      const n = Math.max(...ring.map((p) => p.lat));
      const w = Math.min(...ring.map((p) => p.lon));
      const e = Math.max(...ring.map((p) => p.lon));
      return line.some((p) => p.lat >= s && p.lat <= n && p.lon >= w && p.lon <= e);
    });
  if (!candidates.length) return () => -1;
  const at = (p: LatLon) => candidates.find(({ z }) => pointInPolygon(p, z.polygon))?.i ?? -1;
  // Fast path: if every vertex and the midpoint agree, assume the whole kerb does.
  const mid = at(midpoint(line));
  if (line.every((p) => at(p) === mid)) return () => mid;
  return at;
}

/**
 * An unsurveyed kerb inside a CPZ that isn't a bay is, by design of CPZs, a
 * single yellow line during the zone's hours (or double yellow at any time,
 * which only kerb-level data can tell us).
 */
export function zoneAssessment(zone: CouncilZone, stay: StayWindow, notes: string[], checkNote: string): Assessment {
  const a = assessCarPark({ 'restriction:conditional': `no_parking @ (${zone.hours})` }, stay);
  if (a.status === 'restricted') {
    return {
      ...a,
      confidence: 'medium',
      reasons: [`Controlled zone ${zone.code}: no waiting on single yellow lines (${zone.hours})`],
    };
  }
  return {
    ...a,
    confidence: 'low',
    reasons: [
      ...notes,
      `Controlled zone ${zone.code}: single yellow lines apply ${zone.hours}, so free outside those hours`,
      checkNote,
    ],
  };
}
