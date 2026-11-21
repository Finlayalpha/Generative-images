import { describe, expect, it } from 'vitest';
import { assessCarPark, assessStreetSide, type Tags } from '../src/rules/engine';
import { parseConditional } from '../src/rules/conditional';
import { parseDurationMinutes } from '../src/rules/duration';

// Mon 23 Nov 2026, local time.
const mon = (h: number, m = 0) => new Date(2026, 10, 23, h, m);
// Sat 21 Nov 2026
const sat = (h: number, m = 0) => new Date(2026, 10, 21, h, m);
// Sun 22 Nov 2026
const sun = (h: number, m = 0) => new Date(2026, 10, 22, h, m);

const stay = (start: Date, minutes: number) => ({ start, minutes });

describe('duration parsing', () => {
  it.each([
    ['2 hours', 120],
    ['2 h', 120],
    ['90 min', 90],
    ['30 minutes', 30],
    ['1:30', 90],
    ['1.5 hours', 90],
    ['1 day', 1440],
    ['PT2H', 120],
  ])('%s -> %d', (s, n) => expect(parseDurationMinutes(s)).toBe(n));

  it('rejects junk', () => expect(parseDurationMinutes('soon')).toBeNull());
});

describe('conditional parsing', () => {
  it('splits rules at top-level semicolons only', () => {
    expect(parseConditional('no_parking @ (Mo-Fr 07:00-09:00; Sa 08:00-12:00); no_stopping @ Su 10:00-12:00')).toEqual([
      { value: 'no_parking', condition: 'Mo-Fr 07:00-09:00; Sa 08:00-12:00' },
      { value: 'no_stopping', condition: 'Su 10:00-12:00' },
    ]);
  });
});

describe('street side assessment', () => {
  it('explicitly free, unrestricted street is free with high confidence', () => {
    const tags: Tags = { highway: 'residential', 'parking:both': 'lane', 'parking:both:fee': 'no' };
    const a = assessStreetSide(tags, 'left', stay(mon(10), 120));
    expect(a.status).toBe('free');
    expect(a.confidence).toBe('high');
    expect(a.freeForMinutes).toBe(24 * 60);
  });

  it('missing fee info is free but only medium confidence', () => {
    const a = assessStreetSide({ 'parking:both': 'lane' }, 'right', stay(mon(10), 60));
    expect(a.status).toBe('free');
    expect(a.confidence).toBe('medium');
  });

  it('side-specific tags override both', () => {
    const tags: Tags = { 'parking:both': 'lane', 'parking:both:fee': 'no', 'parking:right': 'no' };
    expect(assessStreetSide(tags, 'left', stay(mon(10), 60)).status).toBe('free');
    expect(assessStreetSide(tags, 'right', stay(mon(10), 60)).status).toBe('no_parking');
  });

  it('no data for a side is unknown', () => {
    expect(assessStreetSide({ 'parking:left': 'lane' }, 'right', stay(mon(10), 60)).status).toBe('unknown');
  });

  describe('time-dependent fee (pay & display Mo-Sa 08:00-18:00)', () => {
    const tags: Tags = {
      'parking:both': 'lane',
      'parking:both:fee': 'no',
      'parking:both:fee:conditional': 'yes @ (Mo-Sa 08:00-18:00)',
    };
    it('paid during the day', () => expect(assessStreetSide(tags, 'left', stay(mon(10), 60)).status).toBe('paid'));
    it('free in the evening', () => expect(assessStreetSide(tags, 'left', stay(mon(19), 120)).status).toBe('free'));
    it('free on Sunday', () => expect(assessStreetSide(tags, 'left', stay(sun(12), 240)).status).toBe('free'));
    it('paid if the stay runs into charging hours', () => {
      const a = assessStreetSide(tags, 'left', stay(sat(7), 120));
      expect(a.status).toBe('paid');
      expect(a.freeForMinutes).toBe(60);
    });
  });

  describe('peak-hour clearway', () => {
    const tags: Tags = {
      'parking:right': 'lane',
      'parking:right:fee': 'no',
      'parking:right:restriction:conditional': 'no_stopping @ (Mo-Fr 07:00-09:30,16:00-18:30)',
    };
    it('ok at midday', () => expect(assessStreetSide(tags, 'right', stay(mon(11), 120)).status).toBe('free'));
    it('restricted if you would still be there at 16:00', () => {
      const a = assessStreetSide(tags, 'right', stay(mon(14), 180));
      expect(a.status).toBe('restricted');
      expect(a.reasons[0]).toContain('no stopping');
      expect(a.freeForMinutes).toBe(120);
    });
    it('ok all weekend', () => expect(assessStreetSide(tags, 'right', stay(sat(15), 300)).status).toBe('free'));
  });

  describe('max stay', () => {
    const tags: Tags = {
      'parking:both': 'lane',
      'parking:both:fee': 'no',
      'parking:both:maxstay:conditional': '2 hours @ (Mo-Fr 08:00-18:00)',
      'parking:both:authentication:disc': 'yes',
    };
    it('short stay fits', () => {
      const a = assessStreetSide(tags, 'left', stay(mon(10), 90));
      expect(a.status).toBe('free');
      expect(a.needsDisc).toBe(true);
    });
    it('long stay is time limited', () => {
      const a = assessStreetSide(tags, 'left', stay(mon(10), 240));
      expect(a.status).toBe('time_limited');
      expect(a.maxStayMinutes).toBe(120);
    });
    it('only counts time while the limit applies', () => {
      // 17:00 + 4h: only 1h falls inside the limited period.
      expect(assessStreetSide(tags, 'left', stay(mon(17), 240)).status).toBe('free');
    });
  });

  it('residents-only zone is permit', () => {
    const tags: Tags = {
      'parking:both': 'lane',
      'parking:both:access': 'yes',
      'parking:both:access:conditional': 'private @ (Mo-Fr 09:00-17:00)',
      'parking:both:zone': 'K',
    };
    const a = assessStreetSide(tags, 'left', stay(mon(12), 60));
    expect(a.status).toBe('permit');
    expect(a.reasons[0]).toContain('zone K');
    expect(assessStreetSide(tags, 'left', stay(mon(18), 60)).status).toBe('free');
  });

  it('stay-dependent fee: first hour free', () => {
    const tags: Tags = { 'parking:both': 'lane', 'parking:both:fee': 'no', 'parking:both:fee:conditional': 'yes @ (stay > 1 hour)' };
    expect(assessStreetSide(tags, 'left', stay(mon(10), 45)).status).toBe('free');
    expect(assessStreetSide(tags, 'left', stay(mon(10), 120)).status).toBe('paid');
  });

  it('unparseable conditions lower confidence instead of guessing', () => {
    const tags: Tags = { 'parking:both': 'lane', 'parking:both:fee': 'no', 'parking:both:restriction:conditional': 'no_parking @ (snow)' };
    const a = assessStreetSide(tags, 'left', stay(mon(10), 60));
    expect(a.confidence).toBe('low');
  });
});

describe('legacy parking:lane scheme', () => {
  it('ticket parking with time interval', () => {
    const tags: Tags = {
      'parking:lane:both': 'parallel',
      'parking:condition:both': 'ticket',
      'parking:condition:both:time_interval': 'Mo-Fr 09:00-18:00',
      'parking:condition:both:default': 'free',
    };
    expect(assessStreetSide(tags, 'left', stay(mon(10), 60)).status).toBe('paid');
    const evening = assessStreetSide(tags, 'left', stay(mon(19), 60));
    expect(evening.status).toBe('free');
    expect(evening.orientation).toBe('parallel');
  });

  it('no_stopping lane', () => {
    expect(assessStreetSide({ 'parking:lane:right': 'no_stopping' }, 'right', stay(mon(10), 60)).status).toBe('no_parking');
  });
});

describe('car parks', () => {
  it('free public car park', () => {
    expect(assessCarPark({ amenity: 'parking', fee: 'no', access: 'yes' }, stay(mon(10), 120)).status).toBe('free');
  });
  it('customers-only', () => {
    expect(assessCarPark({ amenity: 'parking', access: 'customers' }, stay(mon(10), 60)).status).toBe('permit');
  });
  it('closed overnight', () => {
    const tags: Tags = { amenity: 'parking', fee: 'no', opening_hours: '06:00-22:00' };
    expect(assessCarPark(tags, stay(mon(21), 120)).status).toBe('restricted');
    expect(assessCarPark(tags, stay(mon(12), 120)).status).toBe('free');
  });
});
