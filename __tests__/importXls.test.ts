import {
  parseCheckCode,
  elapsedDays,
  calcFledgeFromChecks,
  ImportEntryData,
} from '../lib/importXls';

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(raw: string): ImportEntryData {
  const r = parseCheckCode(raw);
  if (!r.ok) throw new Error(`Expected ok parse for "${raw}" but got: ${r.reason}`);
  return r.data;
}

function check(date: string, data: Partial<ImportEntryData>): { date: string; data: ImportEntryData } {
  return {
    date,
    data: {
      species: 'PM', is_empty_cavity: false, has_nest: false, nest_discarded: false,
      egg_count: 0, discarded_eggs: 0, young_count: 0, nestling_age_days: null,
      dead_young_count: 0, dead_adult_sex: null, gourd_removed: false, has_banding: false,
      notes: null,
      ...data,
    },
  };
}

function emptyCheck(date: string): { date: string; data: ImportEntryData } {
  return check(date, { is_empty_cavity: true });
}

// ── parseCheckCode ────────────────────────────────────────────────────────────

describe('parseCheckCode — empty / X', () => {
  it('returns empty cavity for an empty string', () => {
    expect(ok('').is_empty_cavity).toBe(true);
  });
  it('returns empty cavity for X', () => {
    expect(ok('X').is_empty_cavity).toBe(true);
  });
  it('returns empty cavity for lowercase x', () => {
    expect(ok('x').is_empty_cavity).toBe(true);
  });
});

describe('parseCheckCode — species prefix', () => {
  it('defaults to PM when no species prefix is present', () => {
    expect(ok('5E').species).toBe('PM');
  });
  it('strips PM prefix', () => {
    const d = ok('PM 5E');
    expect(d.species).toBe('PM');
    expect(d.egg_count).toBe(5);
  });
  it('strips HS prefix', () => {
    expect(ok('HS 3E').species).toBe('HS');
  });
  it('recognises bare PMN', () => {
    const d = ok('PMN');
    expect(d.has_nest).toBe(true);
    expect(d.is_empty_cavity).toBe(false);
  });
});

describe('parseCheckCode — basic tokens', () => {
  it('parses egg count', () => {
    expect(ok('5E').egg_count).toBe(5);
  });
  it('parses young count', () => {
    expect(ok('4Y').young_count).toBe(4);
  });
  it('parses HD as nestling_age_days = 0', () => {
    const d = ok('4Y HD');
    expect(d.young_count).toBe(4);
    expect(d.nestling_age_days).toBe(0);
  });
  it('parses {n}DO age in days', () => {
    const d = ok('4Y 14DO');
    expect(d.young_count).toBe(4);
    expect(d.nestling_age_days).toBe(14);
  });
  it('parses discarded eggs', () => {
    const d = ok('5E 1ED');
    expect(d.egg_count).toBe(5);
    expect(d.discarded_eggs).toBe(1);
  });
  it('treats lone {n}ED as both egg_count and discarded_eggs', () => {
    const d = ok('1ED');
    expect(d.egg_count).toBe(1);
    expect(d.discarded_eggs).toBe(1);
  });
  it('parses dead young', () => {
    expect(ok('1DY').dead_young_count).toBe(1);
  });
  it('parses dead young with D suffix (DYD)', () => {
    expect(ok('2DYD').dead_young_count).toBe(2);
  });
  it('parses standalone B as has_banding', () => {
    const d = ok('4Y B');
    expect(d.has_banding).toBe(true);
    expect(d.young_count).toBe(4);
  });
  it('parses GR as gourd_removed', () => {
    expect(ok('GR').gourd_removed).toBe(true);
  });
  it('parses ND as nest_discarded', () => {
    expect(ok('ND').nest_discarded).toBe(true);
  });
});

describe('parseCheckCode — PMCA {n}B banding notation', () => {
  it('parses 4B as 4 young with banding', () => {
    const d = ok('4B');
    expect(d.young_count).toBe(4);
    expect(d.has_banding).toBe(true);
    expect(d.has_nest).toBe(true);
  });
  it('parses 5B as 5 young with banding', () => {
    const d = ok('5B');
    expect(d.young_count).toBe(5);
    expect(d.has_banding).toBe(true);
  });
  it('parses 2B as 2 young with banding', () => {
    const d = ok('2B');
    expect(d.young_count).toBe(2);
    expect(d.has_banding).toBe(true);
  });
  it('does not set egg_count or discarded_eggs for {n}B', () => {
    const d = ok('4B');
    expect(d.egg_count).toBe(0);
    expect(d.discarded_eggs).toBe(0);
  });
});

describe('parseCheckCode — fused tokens', () => {
  it('parses 5YB as 5 young with banding', () => {
    const d = ok('5YB');
    expect(d.young_count).toBe(5);
    expect(d.has_banding).toBe(true);
  });
  it('parses 2Y2EHD (hatching day with eggs and young)', () => {
    const d = ok('2Y2EHD');
    expect(d.young_count).toBe(2);
    expect(d.egg_count).toBe(2);
    expect(d.nestling_age_days).toBe(0);
  });
  it('parses 2Y2Ehd case-insensitively', () => {
    const d = ok('2Y2Ehd');
    expect(d.young_count).toBe(2);
    expect(d.egg_count).toBe(2);
    expect(d.nestling_age_days).toBe(0);
  });
  it('parses 5Y1ED (young with one discarded egg)', () => {
    const d = ok('5Y1ED');
    expect(d.young_count).toBe(5);
    expect(d.discarded_eggs).toBe(1);
  });
  it('parses 3Y14DO (young with explicit age)', () => {
    const d = ok('3Y14DO');
    expect(d.young_count).toBe(3);
    expect(d.nestling_age_days).toBe(14);
  });
  it('parses 1Y5EHD (one young hatching day, five eggs)', () => {
    const d = ok('1Y5EHD');
    expect(d.young_count).toBe(1);
    expect(d.egg_count).toBe(5);
    expect(d.nestling_age_days).toBe(0);
  });
  it('parses 5Y 1DYD (young and dead young, space-separated)', () => {
    const d = ok('5Y 1DYD');
    expect(d.young_count).toBe(5);
    expect(d.dead_young_count).toBe(1);
  });
});

describe('parseCheckCode — notes and errors', () => {
  it('collects unrecognised tokens as notes', () => {
    const d = ok('4Y moved');
    expect(d.young_count).toBe(4);
    expect(d.notes).toMatch(/moved/i);
  });
  it('returns an error when discarded eggs exceed total eggs', () => {
    const r = parseCheckCode('2E 3ED');
    expect(r.ok).toBe(false);
  });
});

// ── elapsedDays ───────────────────────────────────────────────────────────────

describe('elapsedDays', () => {
  it('returns 7 for a one-week gap', () => {
    expect(elapsedDays('2025-05-01', '2025-05-08')).toBe(7);
  });
  it('returns 0 for the same date', () => {
    expect(elapsedDays('2025-06-15', '2025-06-15')).toBe(0);
  });
  it('crosses a month boundary', () => {
    expect(elapsedDays('2025-05-28', '2025-06-04')).toBe(7);
  });
});

// ── calcFledgeFromChecks ──────────────────────────────────────────────────────

describe('calcFledgeFromChecks', () => {
  it('returns 0 when there are no checks', () => {
    expect(calcFledgeFromChecks([], [])).toBe(0);
  });

  it('returns 0 when no check ever has explicit nestling age', () => {
    // No hatch anchor → age-based detection disabled; rely on stated fledge instead
    const checks = [
      check('2025-05-01', { young_count: 4 }),
      emptyCheck('2025-05-29'),
    ];
    expect(calcFledgeFromChecks(checks, ['2025-05-01', '2025-05-29'])).toBe(0);
  });

  it('detects fledge when young disappear after day 26 (explicit hatch anchor)', () => {
    // Hatch on 2025-05-01, age=0. Next check at 2025-05-29 = 28 days → fledge threshold met.
    const checks = [
      check('2025-05-01', { young_count: 4, nestling_age_days: 0 }),
      emptyCheck('2025-05-29'),
    ];
    expect(calcFledgeFromChecks(checks, ['2025-05-01', '2025-05-29'])).toBe(4);
  });

  it('does not count fledge when projected age is below 26', () => {
    // Hatch on 2025-05-01, next check at 2025-05-20 = 19 days
    const checks = [
      check('2025-05-01', { young_count: 4, nestling_age_days: 0 }),
      emptyCheck('2025-05-20'),
    ];
    expect(calcFledgeFromChecks(checks, ['2025-05-01', '2025-05-20'])).toBe(0);
  });

  it('uses explicit age on the curr check when available', () => {
    // 4 young at hatch; 2 gone by day 28 (drop = 2), 2 still present past fledge age.
    // Function counts the drop (2) AND the remaining young past threshold (2) = 4 total.
    const checks = [
      check('2025-05-01', { young_count: 4, nestling_age_days: 0 }),
      check('2025-05-29', { young_count: 2, nestling_age_days: 28 }),
    ];
    expect(calcFledgeFromChecks(checks, ['2025-05-01', '2025-05-29'])).toBe(4);
  });

  it('uses explicit age from curr check to gate fledge threshold', () => {
    // 4 young at hatch; empty cavity recorded with explicit age 28 → drop = 4 fledged
    const checks = [
      check('2025-05-01', { young_count: 4, nestling_age_days: 0 }),
      { date: '2025-05-29', data: { ...emptyCheck('2025-05-29').data, nestling_age_days: 28 } },
    ];
    expect(calcFledgeFromChecks(checks, ['2025-05-01', '2025-05-29'])).toBe(4);
  });

  it('projects hatch date from an explicit intermediate age', () => {
    // Check at day 14 → hatch anchor. Empty cavity 14 days later = day 28 → fledge.
    const checks = [
      check('2025-05-15', { young_count: 4, nestling_age_days: 14 }),
      emptyCheck('2025-05-29'),
    ];
    expect(calcFledgeFromChecks(checks, ['2025-05-15', '2025-05-29'])).toBe(4);
  });

  it('handles {n}B banding check between young checks', () => {
    // 4 young at day 0, then banding at day 15 (4B → young_count=4, no age), then X at day 29
    const checks = [
      check('2025-05-01', { young_count: 4, nestling_age_days: 0 }),
      check('2025-05-16', { young_count: 4, has_banding: true }),
      emptyCheck('2025-05-30'),
    ];
    // hatch anchor = 2025-05-01 (day 0); age at 2025-05-30 = 29 days ≥ 26 → fledge
    expect(calcFledgeFromChecks(checks, ['2025-05-01', '2025-05-16', '2025-05-30'])).toBe(4);
  });

  it('subtracts dead young from the fledge count', () => {
    const checks = [
      check('2025-05-01', { young_count: 4, nestling_age_days: 0 }),
      check('2025-05-29', { young_count: 0, nestling_age_days: 28, dead_young_count: 1 }),
    ];
    expect(calcFledgeFromChecks(checks, ['2025-05-01', '2025-05-29'])).toBe(3);
  });

  it('counts young from the final check when projecting to next scheduled date reaches threshold', () => {
    // Last check at day 20 with 4 young. Next scheduled check is 8 days later (day 28 ≥ 26).
    const checks = [
      check('2025-05-01', { young_count: 4, nestling_age_days: 0 }),
      check('2025-05-21', { young_count: 4, nestling_age_days: 20 }),
    ];
    const allDates = ['2025-05-01', '2025-05-21', '2025-05-29'];
    expect(calcFledgeFromChecks(checks, allDates)).toBe(4);
  });

  it('does not double-count when drop was already detected in the loop', () => {
    // Young go from 4 to 0 at day 28 (detected in loop); last check is empty cavity — no double count.
    const checks = [
      check('2025-05-01', { young_count: 4, nestling_age_days: 0 }),
      emptyCheck('2025-05-29'),
    ];
    expect(calcFledgeFromChecks(checks, ['2025-05-01', '2025-05-29'])).toBe(4);
  });

  it('returns 0 when no young were present in any check', () => {
    const checks = [
      check('2025-05-01', { egg_count: 5 }),
      check('2025-05-15', { egg_count: 5 }),
    ];
    expect(calcFledgeFromChecks(checks, ['2025-05-01', '2025-05-15'])).toBe(0);
  });
});
