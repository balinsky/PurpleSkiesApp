// Integration tests for localDb.ts using an in-memory SQLite database.
// expo-sqlite is replaced by __mocks__/expo-sqlite.ts (better-sqlite3 backed).
// react-native Platform is stubbed via moduleNameMapper in jest.config.js.

import {
  initDb,
  cacheEntries,
  upsertLocalEntry,
  getLocalEntry,
  getLocalEntriesForCompartment,
  getLocalEntriesForCheck,
  getPendingEntries,
  markEntrySynced,
  insertLocalNestCheck,
  getLocalNestChecks,
  cacheNestChecks,
  cacheUnitsAndCompartments,
  makeId,
  localEntryToJs,
} from '../lib/localDb';

// ── Seed helpers ──────────────────────────────────────────────────────────────

const SITE = 'site-1';
const SEASON = 'season-2026';
const UNIT = 'unit-1';
const COMP_A = 'comp-a';
const COMP_B = 'comp-b';
const CHECK_1 = 'check-1';
const CHECK_2 = 'check-2';

async function seedUnitsAndCompartments() {
  await cacheUnitsAndCompartments(
    [{ id: UNIT, site_id: SITE, name: 'House A' }],
    [
      { id: COMP_A, housing_unit_id: UNIT, cavity_label: 'A1', sort_order: 1 },
      { id: COMP_B, housing_unit_id: UNIT, cavity_label: 'A2', sort_order: 2 },
    ],
  );
}

async function seedChecks() {
  await cacheNestChecks([
    { id: CHECK_1, site_id: SITE, check_date: '2026-05-01' },
    { id: CHECK_2, site_id: SITE, check_date: '2026-05-08' },
  ]);
}

function baseEntry(id: string, checkId: string, compartmentId: string, overrides: Record<string, any> = {}) {
  return {
    id,
    nest_check_id: checkId,
    compartment_id: compartmentId,
    species: 'PM',
    is_empty_cavity: false,
    has_nest: true,
    nest_discarded: false,
    nest_replaced: false,
    adult_present: false,
    egg_count: 0,
    discarded_eggs: 0,
    young_count: 0,
    nestling_age_days: null,
    nestling_age_notes: null,
    dead_young_count: 0,
    dead_adult_male: false,
    dead_adult_female: false,
    fledged_count: 0,
    renesting_attempt: false,
    nesting_attempt: 1,
    notes: null,
    observed_male_age: null,
    observed_female_age: null,
    gourd_removed: false,
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

// initDb() calls openDatabaseAsync which returns a fresh in-memory DB each
// time, so calling it in beforeEach resets all state.
beforeEach(async () => {
  await initDb();
});

// ── upsertLocalEntry / getLocalEntry round-trip ───────────────────────────────

describe('upsertLocalEntry / getLocalEntry', () => {
  it('stores and retrieves all scalar fields', async () => {
    const id = makeId();
    await upsertLocalEntry(baseEntry(id, CHECK_1, COMP_A, {
      species: 'HS',
      egg_count: 3,
      young_count: 2,
      nestling_age_days: 7,
      observed_male_age: 'SY',
      notes: 'test note',
    }));
    const row = await getLocalEntry(id);
    expect(row).not.toBeNull();
    expect(row!.species).toBe('HS');
    expect(row!.egg_count).toBe(3);
    expect(row!.young_count).toBe(2);
    expect(row!.nestling_age_days).toBe(7);
    expect(row!.observed_male_age).toBe('SY');
    expect(row!.notes).toBe('test note');
  });

  it('converts boolean fields from SQLite integers to JS booleans', async () => {
    const id = makeId();
    await upsertLocalEntry(baseEntry(id, CHECK_1, COMP_A, {
      is_empty_cavity: true,
      nest_discarded: true,
      renesting_attempt: true,
      gourd_removed: true,
    }));
    const row = await getLocalEntry(id);
    expect(row!.is_empty_cavity).toBe(true);
    expect(row!.nest_discarded).toBe(true);
    expect(row!.renesting_attempt).toBe(true);
    expect(row!.gourd_removed).toBe(true);
    expect(row!.has_nest).toBe(true);
  });

  it('stores false boolean fields as false', async () => {
    const id = makeId();
    await upsertLocalEntry(baseEntry(id, CHECK_1, COMP_A));
    const row = await getLocalEntry(id);
    expect(row!.is_empty_cavity).toBe(false);
    expect(row!.gourd_removed).toBe(false);
  });

  it('returns null for a non-existent id', async () => {
    expect(await getLocalEntry('does-not-exist')).toBeNull();
  });

  it('sets sync_status to pending on upsert', async () => {
    const id = makeId();
    await upsertLocalEntry(baseEntry(id, CHECK_1, COMP_A));
    const row = await getLocalEntry(id);
    expect(row!.sync_status).toBe('pending');
  });
});

// ── cacheEntries / getLocalEntriesForCheck ────────────────────────────────────

describe('cacheEntries', () => {
  it('stores entries retrievable by check id', async () => {
    const id = makeId();
    await cacheEntries([{ ...baseEntry(id, CHECK_1, COMP_A), young_count: 4 }]);
    const rows = await getLocalEntriesForCheck(CHECK_1);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].young_count).toBe(4);
  });

  it('sets sync_status to synced on cache', async () => {
    const id = makeId();
    await cacheEntries([baseEntry(id, CHECK_1, COMP_A)]);
    const rows = await getLocalEntriesForCheck(CHECK_1);
    expect(rows[0].sync_status).toBe('synced');
  });

  it('does not overwrite a locally-pending entry (INSERT OR IGNORE)', async () => {
    const id = makeId();
    // Write a pending entry first
    await upsertLocalEntry(baseEntry(id, CHECK_1, COMP_A, { egg_count: 5 }));
    // Now cache a server version with different data
    await cacheEntries([{ ...baseEntry(id, CHECK_1, COMP_A), egg_count: 0 }]);
    // The pending local data should be preserved
    const rows = await getLocalEntriesForCheck(CHECK_1);
    expect(rows[0].egg_count).toBe(5);
    expect(rows[0].sync_status).toBe('pending');
  });
});

// ── getLocalEntriesForCompartment ─────────────────────────────────────────────

describe('getLocalEntriesForCompartment', () => {
  beforeEach(async () => {
    await seedUnitsAndCompartments();
    await seedChecks();
  });

  it('returns entries for a compartment joined with check_date', async () => {
    const e1 = makeId();
    await cacheEntries([baseEntry(e1, CHECK_1, COMP_A, { egg_count: 3 })]);

    const rows = await getLocalEntriesForCompartment(COMP_A, SITE, 2026, CHECK_2);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(e1);
    expect(rows[0].check_date).toBe('2026-05-01');
    expect(rows[0].egg_count).toBe(3);
  });

  it('excludes the current check', async () => {
    const e1 = makeId();
    const e2 = makeId();
    await cacheEntries([
      baseEntry(e1, CHECK_1, COMP_A),
      baseEntry(e2, CHECK_2, COMP_A),
    ]);

    // Exclude CHECK_2 — only the CHECK_1 entry should appear
    const rows = await getLocalEntriesForCompartment(COMP_A, SITE, 2026, CHECK_2);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(e1);
  });

  it('excludes entries for other compartments', async () => {
    const eA = makeId();
    const eB = makeId();
    await cacheEntries([
      baseEntry(eA, CHECK_1, COMP_A),
      baseEntry(eB, CHECK_1, COMP_B),
    ]);

    const rows = await getLocalEntriesForCompartment(COMP_A, SITE, 2026, CHECK_2);
    expect(rows.every(r => r.id === eA)).toBe(true);
  });

  it('returns rows ordered by check_date ascending', async () => {
    // Add a third check to verify ordering
    await cacheNestChecks([{ id: 'check-0', site_id: SITE, check_date: '2026-04-20' }]);
    const e0 = makeId(); const e1 = makeId();
    await cacheEntries([
      baseEntry(e1, CHECK_1, COMP_A),
      baseEntry(e0, 'check-0', COMP_A),
    ]);

    const rows = await getLocalEntriesForCompartment(COMP_A, SITE, 2026, CHECK_2);
    expect(rows[0].check_date).toBe('2026-04-20');
    expect(rows[1].check_date).toBe('2026-05-01');
  });

  it('returns dead_young_count', async () => {
    const id = makeId();
    await upsertLocalEntry(baseEntry(id, CHECK_1, COMP_A, { young_count: 4, dead_young_count: 1 }));
    const rows = await getLocalEntriesForCompartment(COMP_A, SITE, 2026, CHECK_2);
    expect(rows[0].dead_young_count).toBe(1);
  });

  it('does not cross site boundary (different site_id on the check)', async () => {
    await cacheNestChecks([{ id: 'check-other', site_id: 'site-other', check_date: '2026-05-01' }]);
    const id = makeId();
    await cacheEntries([baseEntry(id, 'check-other', COMP_A)]);
    const rows = await getLocalEntriesForCompartment(COMP_A, SITE, 2026, CHECK_2);
    expect(rows).toHaveLength(0);
  });
});

// ── getPendingEntries / markEntrySynced ───────────────────────────────────────

describe('getPendingEntries / markEntrySynced', () => {
  it('returns only entries with pending sync_status', async () => {
    const pending = makeId();
    const synced = makeId();
    await upsertLocalEntry(baseEntry(pending, CHECK_1, COMP_A));
    await cacheEntries([baseEntry(synced, CHECK_1, COMP_B)]);

    const rows = await getPendingEntries();
    expect(rows.map(r => r.id)).toContain(pending);
    expect(rows.map(r => r.id)).not.toContain(synced);
  });

  it('removes an entry from pending after markEntrySynced', async () => {
    const id = makeId();
    await upsertLocalEntry(baseEntry(id, CHECK_1, COMP_A));
    expect((await getPendingEntries()).map(r => r.id)).toContain(id);

    await markEntrySynced(id);
    expect((await getPendingEntries()).map(r => r.id)).not.toContain(id);
  });
});

// ── insertLocalNestCheck / getLocalNestChecks ─────────────────────────────────

describe('insertLocalNestCheck / getLocalNestChecks', () => {
  it('inserts a nest check retrievable by site and year', async () => {
    const id = makeId();
    await insertLocalNestCheck({ id, site_id: SITE, check_date: '2026-06-15', created_by: null });
    const rows = await getLocalNestChecks(SITE, 2026);
    expect(rows.map(r => r.id)).toContain(id);
  });

  it('returns checks ordered by check_date', async () => {
    await insertLocalNestCheck({ id: 'c-later', site_id: SITE, check_date: '2026-06-20', created_by: null });
    await insertLocalNestCheck({ id: 'c-earlier', site_id: SITE, check_date: '2026-06-10', created_by: null });
    const rows = await getLocalNestChecks(SITE, 2026);
    const dates = rows.map(r => r.check_date);
    expect(dates).toEqual([...dates].sort());
  });

  it('does not return checks from a different year', async () => {
    await insertLocalNestCheck({ id: 'c-2025', site_id: SITE, check_date: '2025-06-01', created_by: null });
    const rows = await getLocalNestChecks(SITE, 2026);
    expect(rows.map(r => r.id)).not.toContain('c-2025');
  });
});

// ── cacheNestChecks INSERT OR IGNORE ─────────────────────────────────────────

describe('cacheNestChecks', () => {
  it('does not overwrite a locally-pending check with the same id', async () => {
    const id = makeId();
    // Insert as pending
    await insertLocalNestCheck({ id, site_id: SITE, check_date: '2026-06-01', created_by: null });
    // Attempt to cache a server version
    await cacheNestChecks([{ id, site_id: SITE, check_date: '2026-01-01' }]);
    const rows = await getLocalNestChecks(SITE, 2026);
    // The local date should be preserved
    expect(rows.find(r => r.id === id)?.check_date).toBe('2026-06-01');
  });
});
