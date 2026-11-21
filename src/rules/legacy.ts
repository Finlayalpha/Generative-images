import type { Tags } from './engine';

/**
 * Translate the deprecated `parking:lane:*` / `parking:condition:*` scheme
 * into the current `parking:<side>:*` street-parking scheme, so the engine
 * only has to understand one model. Existing new-scheme tags always win.
 * https://wiki.openstreetmap.org/wiki/Key:parking:lane
 */
const SIDES = ['left', 'right', 'both'] as const;

type Attrs = Partial<Record<'fee' | 'access' | 'restriction' | 'authentication:disc', string>>;

const NEUTRAL: Required<Attrs> = {
  fee: 'no',
  access: 'yes',
  restriction: 'none',
  'authentication:disc': 'no',
};

function conditionAttrs(c: string | undefined): Attrs {
  switch (c) {
    case 'free': return { fee: 'no' };
    case 'ticket': return { fee: 'yes' };
    case 'disc': return { fee: 'no', 'authentication:disc': 'yes' };
    case 'residents': return { access: 'private' };
    case 'customers': return { access: 'customers' };
    case 'private': return { access: 'private' };
    case 'no_parking':
    case 'no_stopping':
    case 'no_standing': return { restriction: c };
    case 'loading': return { restriction: 'loading_only' };
    default: return {};
  }
}

const LANE_ORIENTATION = new Set(['parallel', 'diagonal', 'perpendicular']);

export function normalizeLegacy(tags: Tags): Tags {
  const hasLegacy = Object.keys(tags).some((k) => k.startsWith('parking:lane:') || k.startsWith('parking:condition:'));
  if (!hasLegacy) return tags;

  const out: Tags = { ...tags };
  const set = (k: string, v: string) => {
    if (out[k] === undefined) out[k] = v;
  };

  for (const side of SIDES) {
    const lane = tags[`parking:lane:${side}`];
    if (lane !== undefined && out[`parking:${side}`] === undefined) {
      if (LANE_ORIENTATION.has(lane)) {
        const position = tags[`parking:lane:${side}:${lane}`];
        set(`parking:${side}`, position === 'on_kerb' || position === 'half_on_kerb' ? position : 'lane');
        set(`parking:${side}:orientation`, lane);
      } else if (lane === 'marked') {
        set(`parking:${side}`, 'lane');
      } else if (lane === 'no_parking' || lane === 'no_stopping' || lane === 'fire_lane') {
        set(`parking:${side}`, 'no');
        set(`parking:${side}:restriction`, lane === 'fire_lane' ? 'no_stopping' : lane);
      } else {
        set(`parking:${side}`, lane); // no, separate, ...
      }
    }

    const p = `parking:condition:${side}`;
    const cond = tags[p];
    if (cond === undefined) continue;
    const interval = tags[`${p}:time_interval`];
    const main = conditionAttrs(cond);

    if (interval) {
      const dflt = conditionAttrs(tags[`${p}:default`]);
      const keys = new Set([...Object.keys(main), ...Object.keys(dflt)] as (keyof Attrs)[]);
      for (const k of keys) {
        set(`parking:${side}:${k}`, dflt[k] ?? NEUTRAL[k]);
        set(`parking:${side}:${k}:conditional`, `${main[k] ?? NEUTRAL[k]} @ (${interval})`);
      }
    } else {
      for (const [k, v] of Object.entries(main)) set(`parking:${side}:${k}`, v);
    }

    const maxstay = tags[`${p}:maxstay`];
    if (maxstay) {
      if (interval) set(`parking:${side}:maxstay:conditional`, `${maxstay} @ (${interval})`);
      else set(`parking:${side}:maxstay`, maxstay);
    }
    const zone = tags[`${p}:residents`];
    if (zone) set(`parking:${side}:zone`, zone);
  }
  return out;
}
