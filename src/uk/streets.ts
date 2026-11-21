import type { Side, Tags } from '../rules/engine';

/**
 * What national UK rules say about a street side whose parking hasn't been mapped.
 *   skip     — not a street people park on (slip roads, service roads); not shown
 *   excluded — parking ruled out for the whole side, with the reason
 *   ok       — nothing known rules it out; suggest it as "unsurveyed"
 */
export type Eligibility =
  | { kind: 'skip' }
  | { kind: 'excluded'; reason: string }
  | { kind: 'ok'; notes: string[] };

const ELIGIBLE = new Set(['primary', 'secondary', 'tertiary', 'unclassified', 'residential']);
const MAIN_ROADS = new Set(['primary', 'secondary']);
const PRIVATE = new Set(['private', 'no', 'customers', 'delivery', 'destination_only_private']);

/** Read `<key>:<side>`, then `<key>:both`, then `<key>`. */
function sided(tags: Tags, key: string, side: Side, suffix = ''): string | undefined {
  return tags[`${key}:${side}${suffix}`] ?? tags[`${key}:both${suffix}`] ?? tags[`${key}${suffix}`];
}

export function speedMph(tags: Tags): number | null {
  const m = /^(\d+)\s*(mph)?$/.exec((tags['maxspeed'] ?? '').trim());
  if (!m) return null;
  // UK speeds are mph; a bare number in OSM means km/h.
  return m[2] ? Number(m[1]) : Number(m[1]) / 1.609;
}

export function inferSide(tags: Tags, side: Side): Eligibility {
  const hw = tags['highway'] ?? '';
  if (tags['area'] === 'yes') return { kind: 'skip' };
  if (hw === 'trunk') return { kind: 'excluded', reason: 'Trunk road: usually a clearway or red route' };
  if (hw === 'living_street') return { kind: 'excluded', reason: 'Home zone: park only in marked spaces' };
  if (!ELIGIBLE.has(hw)) return { kind: 'skip' };

  for (const k of ['access', 'motor_vehicle', 'motorcar']) {
    if (PRIVATE.has(tags[k] ?? '')) return { kind: 'excluded', reason: 'Private road' };
  }
  if (tags['junction'] === 'roundabout' || tags['junction'] === 'circular') return { kind: 'excluded', reason: 'Roundabout' };
  if (tags['tunnel'] === 'yes' || tags['tunnel'] === 'building_passage') return { kind: 'excluded', reason: 'Tunnel' };
  if (tags['overtaking'] === 'no') {
    return { kind: 'excluded', reason: 'Double white centre lines: you must not stop (Highway Code 240)' };
  }
  if (sided(tags, 'cycleway', side) === 'lane') {
    const exclusive = sided(tags, 'cycleway', side, ':lane') === 'exclusive';
    return {
      kind: 'excluded',
      reason: exclusive
        ? 'Mandatory cycle lane: you must not stop in it during its hours (Highway Code 240)'
        : 'Cycle lane: you should not park in it (Highway Code 140)',
    };
  }
  if (sided(tags, 'busway', side) === 'lane') {
    return { kind: 'excluded', reason: 'Bus lane: no stopping during its hours (check the sign)' };
  }

  const notes: string[] = [];
  if (MAIN_ROADS.has(hw)) notes.push('Main road: check for red route, clearway or loading restrictions');
  const mph = speedMph(tags);
  if (mph !== null && mph > 30.5) notes.push('Speed limit over 30 mph: parking lights needed at night (Highway Code 249)');
  return { kind: 'ok', notes };
}
