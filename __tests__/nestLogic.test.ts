import {
  addDays,
  formatDate,
  computeConfirmedAge,
  netEggs,
  buildEntrySummary,
  fledgeUnaccounted,
  incrementBandCode,
  validateFederalBandCode,
  EntrySummaryInput,
  FledgeParams,
} from '../lib/nestLogic';

// ── Helpers ──────────────────────────────────────────────────────────────────

function entry(overrides: Partial<EntrySummaryInput> = {}): EntrySummaryInput {
  return {
    species: 'PM',
    is_empty_cavity: false,
    has_nest: true,
    nest_discarded: false,
    egg_count: 0,
    discarded_eggs: 0,
    young_count: 0,
    nestling_age_days: null,
    ...overrides,
  };
}

function fledge(overrides: Partial<FledgeParams> = {}): FledgeParams {
  return {
    isPM: true,
    prevYoungCount: 4,
    prevNestingAttempt: 1,
    currentNestingAttempt: 1,
    youngCount: 0,
    calculatedNestlingAge: 28,
    nestlingAgeDays: 0,
    isHatchingDay: false,
    fledgedCount: 0,
    hasDeadYoung: false,
    deadYoungCount: 0,
    ...overrides,
  };
}

// ── addDays ───────────────────────────────────────────────────────────────────

describe('addDays', () => {
  it('adds positive days', () => {
    expect(addDays('2026-06-01', 10)).toBe('2026-06-11');
  });
  it('crosses a month boundary', () => {
    expect(addDays('2026-06-25', 10)).toBe('2026-07-05');
  });
  it('crosses a year boundary', () => {
    expect(addDays('2026-12-28', 5)).toBe('2027-01-02');
  });
  it('adds zero days', () => {
    expect(addDays('2026-06-15', 0)).toBe('2026-06-15');
  });
  it('subtracts days with negative input', () => {
    expect(addDays('2026-06-10', -5)).toBe('2026-06-05');
  });
  it('handles 26-day fledge calculation from hatch', () => {
    expect(addDays('2026-05-20', 26)).toBe('2026-06-15');
  });
});

// ── formatDate ────────────────────────────────────────────────────────────────

describe('formatDate', () => {
  it('formats a mid-year date', () => {
    expect(formatDate('2026-06-05')).toBe('Jun 5');
  });
  it('formats January', () => {
    expect(formatDate('2026-01-15')).toBe('Jan 15');
  });
  it('formats December', () => {
    expect(formatDate('2026-12-31')).toBe('Dec 31');
  });
});

// ── computeConfirmedAge ───────────────────────────────────────────────────────

describe('computeConfirmedAge', () => {
  it('returns null when fewer than 3 matching values', () => {
    expect(computeConfirmedAge(['SY', 'ASY'], 'SY')).toBeNull();
  });
  it('returns age when 3 values match', () => {
    expect(computeConfirmedAge(['SY', 'SY'], 'SY')).toBe('SY');
  });
  it('returns age when 4 values match', () => {
    expect(computeConfirmedAge(['ASY', 'ASY', 'ASY'], 'ASY')).toBe('ASY');
  });
  it('ignores nulls', () => {
    expect(computeConfirmedAge([null, 'SY', 'SY'], 'SY')).toBe('SY');
  });
  it('returns null when all values are null', () => {
    expect(computeConfirmedAge([null, null], null)).toBeNull();
  });
  it('first age to reach 3 is confirmed when the other has fewer', () => {
    // 3 ASY + 1 SY → ASY confirmed
    expect(computeConfirmedAge(['ASY', 'ASY', 'ASY'], 'SY')).toBe('ASY');
  });
  it('later set of 3 overrides earlier confirmation (replacement bird)', () => {
    // ASY confirmed first, then SY accumulates 3 later → SY wins
    expect(computeConfirmedAge(['ASY', 'ASY', 'ASY', 'SY', 'SY'], 'SY')).toBe('SY');
  });
  it('second override: a third set of 3 wins again', () => {
    // ASY→SY→ASY each reaching 3 in order; last ASY triple wins
    expect(computeConfirmedAge(['ASY','ASY','ASY','SY','SY','SY','ASY','ASY'], 'ASY')).toBe('ASY');
  });
});

// ── netEggs ───────────────────────────────────────────────────────────────────

describe('netEggs', () => {
  it('returns eggs minus discards', () => {
    expect(netEggs(4, 1)).toBe(3);
  });
  it('returns zero when all eggs are discarded', () => {
    expect(netEggs(1, 1)).toBe(0);
  });
  it('clamps to zero when discards exceed eggs', () => {
    expect(netEggs(2, 5)).toBe(0);
  });
  it('returns full count when no discards', () => {
    expect(netEggs(6, 0)).toBe(6);
  });
});

// ── buildEntrySummary ─────────────────────────────────────────────────────────

describe('buildEntrySummary', () => {
  it('appends "Gourd removed" to the summary when gourd_removed is true', () => {
    expect(buildEntrySummary(entry({ gourd_removed: true }))).toBe('Purple Martin nest · Gourd removed');
  });

  it('stacks Gourd removed with egg count', () => {
    expect(buildEntrySummary(entry({ egg_count: 3, gourd_removed: true }))).toBe('Purple Martin · 3 eggs · Gourd removed');
  });

  it('returns "Empty cavity" for empty cavity', () => {
    expect(buildEntrySummary(entry({ is_empty_cavity: true }))).toBe('Empty cavity');
  });

  it('returns adult present text when adult present', () => {
    expect(buildEntrySummary(entry({ adult_present: true }))).toBe('Adult present · not checked');
  });

  it('returns null when has_nest is false (not entered)', () => {
    expect(buildEntrySummary(entry({ has_nest: false }))).toBeNull();
  });

  it('returns "Purple Martin nest" for PM with no eggs or young', () => {
    expect(buildEntrySummary(entry())).toBe('Purple Martin nest');
  });

  it('shows egg count for PM with eggs', () => {
    expect(buildEntrySummary(entry({ egg_count: 5 }))).toBe('Purple Martin · 5 eggs');
  });

  it('uses singular "egg" for 1 egg', () => {
    expect(buildEntrySummary(entry({ egg_count: 1 }))).toBe('Purple Martin · 1 egg');
  });

  it('shows egg and discard counts when both present', () => {
    expect(buildEntrySummary(entry({ egg_count: 4, discarded_eggs: 1 })))
      .toBe('Purple Martin · 4 eggs, 1 discarded');
  });

  it('shows egg and discard counts even when net is zero', () => {
    // discard info is preserved even when all eggs are discarded
    expect(buildEntrySummary(entry({ egg_count: 1, discarded_eggs: 1 })))
      .toBe('Purple Martin · 1 egg, 1 discarded');
  });

  it('shows young count', () => {
    expect(buildEntrySummary(entry({ young_count: 4 }))).toBe('Purple Martin · 4 young');
  });

  it('appends nestling age in days', () => {
    expect(buildEntrySummary(entry({ young_count: 3, nestling_age_days: 10 })))
      .toBe('Purple Martin · 3 young · 10do');
  });

  it('appends HD for hatching day (age = 0)', () => {
    expect(buildEntrySummary(entry({ young_count: 2, nestling_age_days: 0 })))
      .toBe('Purple Martin · 2 young · HD');
  });

  it('shows fledged count even when no eggs or young remain', () => {
    expect(buildEntrySummary(entry({ fledged_count: 3 }))).toBe('Purple Martin nest · 3 fledged');
  });

  it('shows fledged count alongside remaining young', () => {
    expect(buildEntrySummary(entry({ young_count: 1, fledged_count: 2 })))
      .toBe('Purple Martin · 1 young · 2 fledged');
  });

  it('appends "discarded" for nest_discarded', () => {
    expect(buildEntrySummary(entry({ nest_discarded: true }))).toBe('Purple Martin nest · discarded');
  });

  it('appends "RA" for renesting attempt', () => {
    expect(buildEntrySummary(entry({ renesting_attempt: true }))).toBe('Purple Martin nest · RA');
  });

  it('appends male age for PM', () => {
    expect(buildEntrySummary(entry({ male_age: 'SY' }))).toBe('Purple Martin nest · ♂ SY');
  });

  it('appends both ages for PM', () => {
    expect(buildEntrySummary(entry({ male_age: 'SY', female_age: 'ASY' })))
      .toBe('Purple Martin nest · ♂ SY ♀ ASY');
  });

  it('appends "B" for banding', () => {
    expect(buildEntrySummary(entry({ has_banding: true }))).toBe('Purple Martin nest · B');
  });

  it('returns "House Sparrow nest" for HS', () => {
    expect(buildEntrySummary(entry({ species: 'HS' }))).toBe('House Sparrow nest');
  });

  it('does not show ages for non-PM species', () => {
    expect(buildEntrySummary(entry({ species: 'HS', male_age: 'SY' }))).toBe('House Sparrow nest');
  });

  it('combines multiple flags', () => {
    expect(buildEntrySummary(entry({ egg_count: 3, fledged_count: 0, renesting_attempt: true, has_banding: true })))
      .toBe('Purple Martin · 3 eggs · RA · B');
  });
});

// ── fledgeUnaccounted ─────────────────────────────────────────────────────────

describe('fledgeUnaccounted', () => {
  it('returns the full reduction when young disappeared at fledge age', () => {
    expect(fledgeUnaccounted(fledge())).toBe(4);
  });

  it('returns 0 for non-PM species', () => {
    expect(fledgeUnaccounted(fledge({ isPM: false }))).toBe(0);
  });

  it('returns 0 when no previous young', () => {
    expect(fledgeUnaccounted(fledge({ prevYoungCount: 0 }))).toBe(0);
  });

  it('returns 0 when previous young count is null', () => {
    expect(fledgeUnaccounted(fledge({ prevYoungCount: null }))).toBe(0);
  });

  it('returns 0 when young count has not decreased', () => {
    expect(fledgeUnaccounted(fledge({ youngCount: 4 }))).toBe(0);
  });

  it('returns 0 when nestling age is below 26 days', () => {
    expect(fledgeUnaccounted(fledge({ calculatedNestlingAge: 25 }))).toBe(0);
  });

  it('returns reduction at exactly 26 days', () => {
    expect(fledgeUnaccounted(fledge({ calculatedNestlingAge: 26 }))).toBe(4);
  });

  it('returns 0 when age cannot be determined', () => {
    expect(fledgeUnaccounted(fledge({ calculatedNestlingAge: null, youngCount: 0, nestlingAgeDays: 0 }))).toBe(0);
  });

  it('uses manual nestling age when calculated age is unavailable and young remain', () => {
    expect(fledgeUnaccounted(fledge({
      calculatedNestlingAge: null,
      youngCount: 2,
      nestlingAgeDays: 27,
    }))).toBe(2); // 4 prev - 2 current = 2 reduction
  });

  it('returns 0 when all missing young are already marked fledged', () => {
    expect(fledgeUnaccounted(fledge({ fledgedCount: 4 }))).toBe(0);
  });

  it('returns 0 when missing young are accounted for by dead young', () => {
    expect(fledgeUnaccounted(fledge({ hasDeadYoung: true, deadYoungCount: 4 }))).toBe(0);
  });

  it('returns full reduction when user marked partial fledge and gap remains', () => {
    // 4 prev, 1 current → reduction 3; user marked 2 fledged → 1 unaccounted → returns 3 (full)
    expect(fledgeUnaccounted(fledge({ youngCount: 1, fledgedCount: 2 }))).toBe(3);
  });

  it('returns 0 when nesting attempts differ', () => {
    expect(fledgeUnaccounted(fledge({ prevNestingAttempt: 1, currentNestingAttempt: 2 }))).toBe(0);
  });
});

// ── incrementBandCode ─────────────────────────────────────────────────────────

describe('incrementBandCode', () => {
  it('increments a federal band number', () => {
    expect(incrementBandCode('2841-74209')).toBe('2841-74210');
  });
  it('increments a code with a prefix', () => {
    expect(incrementBandCode('TX 403')).toBe('TX 404');
  });
  it('preserves leading zeros when incrementing', () => {
    expect(incrementBandCode('2841-07009')).toBe('2841-07010');
  });
  it('returns unchanged when there are no digits', () => {
    expect(incrementBandCode('Red')).toBe('Red');
  });
  it('increments a plain number', () => {
    expect(incrementBandCode('12345678')).toBe('12345679');
  });
  it('increments the last digit group, not the first', () => {
    expect(incrementBandCode('2841-74999')).toBe('2841-75000');
  });
});

// ── validateFederalBandCode ───────────────────────────────────────────────────

describe('validateFederalBandCode', () => {
  it('accepts an 8-digit code', () => {
    expect(validateFederalBandCode('12345678')).toBeNull();
  });
  it('accepts a 9-digit code', () => {
    expect(validateFederalBandCode('123456789')).toBeNull();
  });
  it('accepts an 8-digit code with a dash', () => {
    expect(validateFederalBandCode('1234-5678')).toBeNull();
  });
  it('rejects a code that is too short', () => {
    expect(validateFederalBandCode('1234567')).toMatch(/8 or 9 digits/);
  });
  it('reports the actual length when too short', () => {
    expect(validateFederalBandCode('123456')).toMatch(/you entered 6/);
  });
  it('rejects a code that is too long', () => {
    expect(validateFederalBandCode('1234567890')).toMatch(/8 or 9 digits/);
  });
  it('rejects a code with letters', () => {
    expect(validateFederalBandCode('TX1234567')).toMatch(/only contain digits/);
  });
  it('rejects a code with special characters other than a dash', () => {
    expect(validateFederalBandCode('1234.5678')).toMatch(/only contain digits/);
  });
});

