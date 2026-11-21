import opening_hours from 'opening_hours';
import { parseDurationMinutes } from './duration';

/**
 * OSM conditional restriction syntax:
 *   <value> @ <condition>[; <value> @ <condition>]...
 * e.g. `no_parking @ (Mo-Fr 07:00-09:00); no_stopping @ (Sa 08:00-13:00)`
 * See https://wiki.openstreetmap.org/wiki/Conditional_restrictions
 */
export interface ConditionalRule {
  value: string;
  condition: string;
}

export interface EvalContext {
  /** Requested length of stay in minutes (for `stay > 2 hours` style conditions). */
  stayMinutes: number;
}

export type Tri = true | false | 'unknown';

/** Split on `;` that are not nested inside parentheses. */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((p) => p.trim()).filter(Boolean);
}

function stripOuterParens(s: string): string {
  let t = s.trim();
  while (t.startsWith('(') && t.endsWith(')')) {
    // Only strip if the opening paren matches the final closing paren.
    let depth = 0;
    let wrapsAll = true;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++;
      else if (t[i] === ')') depth--;
      if (depth === 0 && i < t.length - 1) {
        wrapsAll = false;
        break;
      }
    }
    if (!wrapsAll) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

export function parseConditional(raw: string): ConditionalRule[] {
  const rules: ConditionalRule[] = [];
  for (const part of splitTopLevel(raw, ';')) {
    const at = part.indexOf('@');
    if (at < 0) continue;
    const value = part.slice(0, at).trim();
    const condition = stripOuterParens(part.slice(at + 1));
    if (value && condition) rules.push({ value, condition });
  }
  return rules;
}

const ohCache = new Map<string, opening_hours | null>();

function getOpeningHours(expr: string): opening_hours | null {
  if (ohCache.has(expr)) return ohCache.get(expr) ?? null;
  let oh: opening_hours | null = null;
  try {
    oh = new opening_hours(expr, null, 0);
  } catch {
    oh = null;
  }
  ohCache.set(expr, oh);
  return oh;
}

/** Evaluate an opening_hours-style time expression at `t`. */
export function timeMatches(expr: string, t: Date): Tri {
  const oh = getOpeningHours(expr);
  if (!oh) return 'unknown';
  try {
    if (oh.getUnknown(t)) return 'unknown';
    return oh.getState(t);
  } catch {
    // e.g. public holidays / sunrise without location context.
    return 'unknown';
  }
}

const STAY_RE = /^stay\s*(<=|>=|<|>)\s*(.+)$/i;

function evalAtom(atom: string, t: Date, ctx: EvalContext): Tri {
  const stay = STAY_RE.exec(atom);
  if (stay) {
    const limit = parseDurationMinutes(stay[2] ?? '');
    if (limit === null) return 'unknown';
    const s = ctx.stayMinutes;
    switch (stay[1]) {
      case '<': return s < limit;
      case '<=': return s <= limit;
      case '>': return s > limit;
      case '>=': return s >= limit;
    }
  }
  return timeMatches(atom, t);
}

/** Evaluate a condition; supports `AND` conjunctions of time / stay atoms. */
export function conditionMatches(condition: string, t: Date, ctx: EvalContext): Tri {
  const atoms = condition.split(/\s+AND\s+/).map((a) => stripOuterParens(a));
  let result: Tri = true;
  for (const atom of atoms) {
    const r = evalAtom(atom, t, ctx);
    if (r === false) return false;
    if (r === 'unknown') result = 'unknown';
  }
  return result;
}

export interface ResolvedValue {
  value: string | undefined;
  /** True if some condition could not be evaluated, so the value may be wrong. */
  uncertain: boolean;
  /** The condition that produced the value, if a conditional rule matched. */
  via?: string;
}

/**
 * Resolve `<key>` and `<key>:conditional` at time t.
 * Per the OSM spec, when several conditions match, the last one wins.
 */
export function resolve(
  base: string | undefined,
  conditional: string | undefined,
  t: Date,
  ctx: EvalContext,
): ResolvedValue {
  const out: ResolvedValue = { value: base, uncertain: false };
  if (!conditional) return out;
  for (const rule of parseConditional(conditional)) {
    const m = conditionMatches(rule.condition, t, ctx);
    if (m === true) {
      out.value = rule.value;
      out.via = rule.condition;
    } else if (m === 'unknown') {
      out.uncertain = true;
    }
  }
  return out;
}
