import { makeId, localEntryToJs, LocalEntry } from '../lib/localDb';

// ── makeId ────────────────────────────────────────────────────────────────────

describe('makeId', () => {
  it('produces a UUID v4 formatted string', () => {
    expect(makeId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('produces unique values on successive calls', () => {
    const ids = Array.from({ length: 100 }, makeId);
    expect(new Set(ids).size).toBe(100);
  });
});

// ── localEntryToJs ────────────────────────────────────────────────────────────

function rawEntry(overrides: Partial<LocalEntry> = {}): LocalEntry {
  return {
    id: 'test-id',
    nest_check_id: 'check-id',
    compartment_id: 'comp-id',
    species: 'PM',
    is_empty_cavity: 0,
    has_nest: 0,
    nest_discarded: 0,
    nest_replaced: 0,
    adult_present: 0,
    egg_count: 0,
    discarded_eggs: 0,
    young_count: 0,
    nestling_age_days: null,
    nestling_age_notes: null,
    dead_young_count: 0,
    dead_adult_sex: null,
    fledged_count: 0,
    renesting_attempt: 0,
    nesting_attempt: 1,
    notes: null,
    observed_male_age: null,
    observed_female_age: null,
    gourd_removed: 0,
    sync_status: 'synced',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('localEntryToJs', () => {
  it('converts integer 1 to true for boolean fields', () => {
    const result = localEntryToJs(rawEntry({
      is_empty_cavity: 1, has_nest: 1, nest_discarded: 1, nest_replaced: 1,
      adult_present: 1, renesting_attempt: 1, gourd_removed: 1,
    }));
    expect(result.is_empty_cavity).toBe(true);
    expect(result.has_nest).toBe(true);
    expect(result.nest_discarded).toBe(true);
    expect(result.nest_replaced).toBe(true);
    expect(result.adult_present).toBe(true);
    expect(result.renesting_attempt).toBe(true);
    expect(result.gourd_removed).toBe(true);
  });

  it('converts integer 0 to false for boolean fields', () => {
    const result = localEntryToJs(rawEntry());
    expect(result.is_empty_cavity).toBe(false);
    expect(result.has_nest).toBe(false);
    expect(result.nest_discarded).toBe(false);
    expect(result.renesting_attempt).toBe(false);
    expect(result.gourd_removed).toBe(false);
  });

  it('preserves non-boolean numeric fields unchanged', () => {
    const result = localEntryToJs(rawEntry({ egg_count: 4, young_count: 2, dead_young_count: 1 }));
    expect(result.egg_count).toBe(4);
    expect(result.young_count).toBe(2);
    expect(result.dead_young_count).toBe(1);
  });

  it('preserves nullable string fields', () => {
    const result = localEntryToJs(rawEntry({ observed_male_age: 'SY', notes: 'test note' }));
    expect(result.observed_male_age).toBe('SY');
    expect(result.notes).toBe('test note');
  });

  it('preserves null fields', () => {
    const result = localEntryToJs(rawEntry({ nestling_age_days: null, observed_female_age: null }));
    expect(result.nestling_age_days).toBeNull();
    expect(result.observed_female_age).toBeNull();
  });
});
