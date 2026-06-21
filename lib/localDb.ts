import { Platform } from 'react-native';
import * as SQLite from 'expo-sqlite';

let _db: SQLite.SQLiteDatabase | null = null;

export async function initDb(): Promise<void> {
  _db = await SQLite.openDatabaseAsync('purpleskies.db');
  await _db.execAsync('PRAGMA journal_mode = WAL');
  await _db.execAsync(`
    CREATE TABLE IF NOT EXISTS housing_units (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      name TEXT NOT NULL,
      site_season_id TEXT
    );
    CREATE TABLE IF NOT EXISTS compartments (
      id TEXT PRIMARY KEY,
      housing_unit_id TEXT NOT NULL,
      cavity_label TEXT NOT NULL,
      sort_order INTEGER,
      site_season_id TEXT
    );
    CREATE TABLE IF NOT EXISTS nest_checks (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      check_date TEXT NOT NULL,
      created_by TEXT,
      sync_status TEXT NOT NULL DEFAULT 'synced'
    );
    CREATE TABLE IF NOT EXISTS nest_check_entries (
      id TEXT PRIMARY KEY,
      nest_check_id TEXT NOT NULL,
      compartment_id TEXT NOT NULL,
      species TEXT NOT NULL DEFAULT 'PM',
      is_empty_cavity INTEGER NOT NULL DEFAULT 0,
      has_nest INTEGER NOT NULL DEFAULT 0,
      nest_discarded INTEGER NOT NULL DEFAULT 0,
      nest_replaced INTEGER NOT NULL DEFAULT 0,
      adult_present INTEGER NOT NULL DEFAULT 0,
      egg_count INTEGER NOT NULL DEFAULT 0,
      discarded_eggs INTEGER NOT NULL DEFAULT 0,
      young_count INTEGER NOT NULL DEFAULT 0,
      nestling_age_days INTEGER,
      nestling_age_notes TEXT,
      dead_young_count INTEGER NOT NULL DEFAULT 0,
      dead_adult_male INTEGER NOT NULL DEFAULT 0,
      dead_adult_female INTEGER NOT NULL DEFAULT 0,
      fledged_count INTEGER NOT NULL DEFAULT 0,
      renesting_attempt INTEGER NOT NULL DEFAULT 0,
      nesting_attempt INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      observed_male_age TEXT,
      observed_female_age TEXT,
      gourd_removed INTEGER NOT NULL DEFAULT 0,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nestlings (
      id TEXT PRIMARY KEY,
      compartment_id TEXT NOT NULL,
      site_season_id TEXT NOT NULL,
      label TEXT,
      sync_status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS bands (
      id TEXT PRIMARY KEY,
      nest_check_entry_id TEXT NOT NULL,
      nestling_id TEXT,
      is_new_banding INTEGER NOT NULL DEFAULT 1,
      bird_type TEXT,
      band_type TEXT,
      band_color TEXT,
      band_code TEXT,
      sync_status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS nest_seasons (
      id TEXT PRIMARY KEY,
      compartment_id TEXT NOT NULL,
      site_season_id TEXT NOT NULL,
      year INTEGER,
      male_age TEXT,
      female_age TEXT,
      sync_status TEXT NOT NULL DEFAULT 'pending'
    );
  `);
  // Migrate existing databases: add nesting_attempt if not yet present
  try {
    await _db.execAsync('ALTER TABLE nest_check_entries ADD COLUMN nesting_attempt INTEGER NOT NULL DEFAULT 1');
  } catch {}
  try {
    await _db.execAsync('ALTER TABLE nest_check_entries ADD COLUMN adult_present INTEGER NOT NULL DEFAULT 0');
  } catch {}
  try {
    await _db.execAsync('ALTER TABLE nest_check_entries ADD COLUMN gourd_removed INTEGER NOT NULL DEFAULT 0');
  } catch {}
  try {
    await _db.execAsync('ALTER TABLE housing_units ADD COLUMN site_season_id TEXT');
  } catch {}
  try {
    await _db.execAsync('ALTER TABLE compartments ADD COLUMN site_season_id TEXT');
  } catch {}
  // One-time cleanup: remove duplicate band rows caused by cacheBands running without
  // an id in the select, then mark all remaining bands pending so the next sync
  // overwrites the duplicates in Supabase with clean data.
  try {
    await _db.execAsync(`
      DELETE FROM bands WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM bands
        GROUP BY nest_check_entry_id, nestling_id, bird_type, band_type, band_code, band_color
      )
    `);
    await _db.execAsync("UPDATE bands SET sync_status = 'pending'");
  } catch {}
}

async function db(): Promise<SQLite.SQLiteDatabase> {
  if (Platform.OS === 'web') throw new Error('SQLite not available on web');
  if (!_db) await initDb();
  return _db!;
}

// ── Utilities ─────────────────────────────────────────────────────────

export function makeId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── Housing units & compartments ──────────────────────────────────────

export async function cacheUnitsAndCompartments(
  units: { id: string; name: string; site_id: string; site_season_id?: string | null }[],
  compartments: { id: string; housing_unit_id: string; cavity_label: string; sort_order: number | null; site_season_id?: string | null }[],
): Promise<void> {
  const D = await db();
  for (const U of units) {
    await D.runAsync(
      'INSERT OR REPLACE INTO housing_units (id, site_id, name, site_season_id) VALUES (?,?,?,?)',
      [U.id, U.site_id, U.name, U.site_season_id ?? null],
    );
  }
  for (const C of compartments) {
    await D.runAsync(
      'INSERT OR REPLACE INTO compartments (id, housing_unit_id, cavity_label, sort_order, site_season_id) VALUES (?,?,?,?,?)',
      [C.id, C.housing_unit_id, C.cavity_label, C.sort_order ?? null, C.site_season_id ?? null],
    );
  }
}

export async function getLocalUnitsWithCompartments(
  seasonId: string,
): Promise<{ id: string; name: string; compartments: { id: string; cavity_label: string; sort_order: number | null }[] }[]> {
  const D = await db();
  const units = await D.getAllAsync<{ id: string; name: string }>(
    'SELECT id, name FROM housing_units WHERE site_season_id = ? ORDER BY name',
    [seasonId],
  );
  const result = [];
  for (const U of units) {
    const comps = await D.getAllAsync<{ id: string; cavity_label: string; sort_order: number | null }>(
      'SELECT id, cavity_label, sort_order FROM compartments WHERE housing_unit_id = ? ORDER BY sort_order, cavity_label',
      [U.id],
    );
    result.push({ ...U, compartments: comps });
  }
  return result;
}

// ── Nest checks ───────────────────────────────────────────────────────

export async function cacheNestChecks(
  checks: { id: string; site_id: string; check_date: string; created_by?: string | null }[],
): Promise<void> {
  const D = await db();
  for (const C of checks) {
    // INSERT OR IGNORE preserves any locally-pending check with the same id
    await D.runAsync(
      "INSERT OR IGNORE INTO nest_checks (id, site_id, check_date, created_by, sync_status) VALUES (?,?,?,?,'synced')",
      [C.id, C.site_id, C.check_date, C.created_by ?? null],
    );
  }
}

export async function insertLocalNestCheck(check: {
  id: string; site_id: string; check_date: string; created_by: string | null;
}): Promise<void> {
  const D = await db();
  await D.runAsync(
    "INSERT INTO nest_checks (id, site_id, check_date, created_by, sync_status) VALUES (?,?,?,?,'pending')",
    [check.id, check.site_id, check.check_date, check.created_by],
  );
}

export async function getLocalNestChecks(
  siteId: string, year: number,
): Promise<{ id: string; check_date: string }[]> {
  const D = await db();
  return D.getAllAsync<{ id: string; check_date: string }>(
    'SELECT id, check_date FROM nest_checks WHERE site_id = ? AND check_date BETWEEN ? AND ? ORDER BY check_date',
    [siteId, `${year}-01-01`, `${year}-12-31`],
  );
}

export async function getPendingNestChecks(): Promise<{
  id: string; site_id: string; check_date: string; created_by: string | null;
}[]> {
  const D = await db();
  return D.getAllAsync(
    "SELECT id, site_id, check_date, created_by FROM nest_checks WHERE sync_status = 'pending'",
  );
}

export async function markNestCheckSynced(id: string): Promise<void> {
  const D = await db();
  await D.runAsync("UPDATE nest_checks SET sync_status = 'synced' WHERE id = ?", [id]);
}

// ── Nest check entries ────────────────────────────────────────────────

export type LocalEntry = {
  id: string; nest_check_id: string; compartment_id: string;
  species: string; is_empty_cavity: number; has_nest: number;
  nest_discarded: number; nest_replaced: number; adult_present: number;
  egg_count: number; discarded_eggs: number; young_count: number;
  nestling_age_days: number | null; nestling_age_notes: string | null;
  dead_young_count: number; dead_adult_male: number; dead_adult_female: number;
  fledged_count: number; renesting_attempt: number; nesting_attempt: number;
  notes: string | null; observed_male_age: string | null; observed_female_age: string | null;
  gourd_removed: number;
  sync_status: string; updated_at: string;
};

// SQLite stores booleans as 0/1; convert back to JS booleans to match Supabase shape
export function localEntryToJs(E: LocalEntry) {
  return {
    ...E,
    is_empty_cavity:   !!E.is_empty_cavity,
    has_nest:          !!E.has_nest,
    nest_discarded:    !!E.nest_discarded,
    nest_replaced:     !!E.nest_replaced,
    adult_present:     !!E.adult_present,
    dead_adult_male:   !!E.dead_adult_male,
    dead_adult_female: !!E.dead_adult_female,
    renesting_attempt: !!E.renesting_attempt,
    gourd_removed:     !!E.gourd_removed,
  };
}

export async function cacheEntries(entries: any[]): Promise<void> {
  const D = await db();
  const now = new Date().toISOString();
  for (const E of entries) {
    // INSERT OR IGNORE: never overwrite a locally-pending entry with stale server data
    await D.runAsync(
      `INSERT OR IGNORE INTO nest_check_entries
       (id,nest_check_id,compartment_id,species,is_empty_cavity,has_nest,nest_discarded,nest_replaced,adult_present,
        egg_count,discarded_eggs,young_count,nestling_age_days,nestling_age_notes,
        dead_young_count,dead_adult_male,dead_adult_female,fledged_count,renesting_attempt,nesting_attempt,
        notes,observed_male_age,observed_female_age,gourd_removed,sync_status,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'synced',?)`,
      [
        E.id, E.nest_check_id, E.compartment_id, E.species ?? 'PM',
        E.is_empty_cavity ? 1 : 0, E.has_nest ? 1 : 0,
        E.nest_discarded ? 1 : 0, E.nest_replaced ? 1 : 0, E.adult_present ? 1 : 0,
        E.egg_count ?? 0, E.discarded_eggs ?? 0, E.young_count ?? 0,
        E.nestling_age_days ?? null, E.nestling_age_notes ?? null,
        E.dead_young_count ?? 0, E.dead_adult_male ? 1 : 0, E.dead_adult_female ? 1 : 0,
        E.fledged_count ?? 0, E.renesting_attempt ? 1 : 0, E.nesting_attempt ?? 1,
        E.notes ?? null, E.observed_male_age ?? null, E.observed_female_age ?? null,
        E.gourd_removed ? 1 : 0,
        now,
      ],
    );
  }
}

export async function upsertLocalEntry(E: {
  id: string; nest_check_id: string; compartment_id: string;
  species: string; is_empty_cavity: boolean; has_nest: boolean;
  nest_discarded: boolean; nest_replaced: boolean; adult_present: boolean;
  egg_count: number; discarded_eggs: number; young_count: number;
  nestling_age_days: number | null; nestling_age_notes: null;
  dead_young_count: number; dead_adult_male: boolean; dead_adult_female: boolean;
  fledged_count: number; renesting_attempt: boolean; nesting_attempt?: number;
  notes: string | null; observed_male_age: string | null; observed_female_age: string | null;
  gourd_removed: boolean;
}): Promise<void> {
  const D = await db();
  await D.runAsync(
    `INSERT OR REPLACE INTO nest_check_entries
     (id,nest_check_id,compartment_id,species,is_empty_cavity,has_nest,nest_discarded,nest_replaced,adult_present,
      egg_count,discarded_eggs,young_count,nestling_age_days,nestling_age_notes,
      dead_young_count,dead_adult_male,dead_adult_female,fledged_count,renesting_attempt,nesting_attempt,
      notes,observed_male_age,observed_female_age,gourd_removed,sync_status,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`,
    [
      E.id, E.nest_check_id, E.compartment_id, E.species,
      E.is_empty_cavity ? 1 : 0, E.has_nest ? 1 : 0,
      E.nest_discarded ? 1 : 0, E.nest_replaced ? 1 : 0, E.adult_present ? 1 : 0,
      E.egg_count, E.discarded_eggs, E.young_count,
      E.nestling_age_days, E.nestling_age_notes,
      E.dead_young_count, E.dead_adult_male ? 1 : 0, E.dead_adult_female ? 1 : 0,
      E.fledged_count, E.renesting_attempt ? 1 : 0, E.nesting_attempt ?? 1,
      E.notes, E.observed_male_age, E.observed_female_age,
      E.gourd_removed ? 1 : 0,
      new Date().toISOString(),
    ],
  );
}

export async function setLocalEntriesNestingAttempt(ids: string[], nestingAttempt: number): Promise<void> {
  const D = await db();
  for (const id of ids) {
    await D.runAsync('UPDATE nest_check_entries SET nesting_attempt = ? WHERE id = ?', [nestingAttempt, id]);
  }
}

export async function resetLocalNestingAttemptsForCompartment(
  compartmentId: string, siteId: string, year: number,
  fromAttempt: number, toAttempt: number,
): Promise<void> {
  const D = await db();
  await D.runAsync(
    `UPDATE nest_check_entries SET nesting_attempt = ?
     WHERE compartment_id = ? AND nesting_attempt >= ? AND nest_check_id IN (
       SELECT id FROM nest_checks WHERE site_id = ?
         AND check_date BETWEEN ? AND ?
     )`,
    [toAttempt, compartmentId, fromAttempt, siteId, `${year}-01-01`, `${year}-12-31`],
  );
}

export async function getLocalEntry(id: string): Promise<ReturnType<typeof localEntryToJs> | null> {
  const D = await db();
  const E = await D.getFirstAsync<LocalEntry>('SELECT * FROM nest_check_entries WHERE id = ?', [id]);
  return E ? localEntryToJs(E) : null;
}

export async function getLocalEntriesForCheck(checkId: string): Promise<LocalEntry[]> {
  const D = await db();
  return D.getAllAsync<LocalEntry>(
    'SELECT * FROM nest_check_entries WHERE nest_check_id = ?', [checkId],
  );
}

// Returns entries for a compartment in the same season, excluding the current check
export async function getLocalEntriesForCompartment(
  compartmentId: string, siteId: string, year: number, excludeCheckId: string,
): Promise<{
  id: string; check_date: string; species: string; is_empty_cavity: number; has_nest: number;
  nest_discarded: number; adult_present: number; egg_count: number; discarded_eggs: number;
  young_count: number; dead_young_count: number;
  nestling_age_days: number | null; observed_male_age: string | null; observed_female_age: string | null;
  nest_check_id: string; nesting_attempt: number; renesting_attempt: number;
}[]> {
  const D = await db();
  return D.getAllAsync(
    `SELECT nce.id, nce.species, nce.is_empty_cavity, nce.has_nest, nce.nest_discarded,
            nce.adult_present, nce.egg_count, nce.discarded_eggs, nce.young_count, nce.dead_young_count,
            nce.nestling_age_days, nce.observed_male_age, nce.observed_female_age,
            nce.nest_check_id, nce.nesting_attempt, nce.renesting_attempt, nc.check_date
     FROM nest_check_entries nce
     JOIN nest_checks nc ON nc.id = nce.nest_check_id
     WHERE nce.compartment_id = ? AND nc.site_id = ? AND nc.id != ?
       AND nc.check_date BETWEEN ? AND ?
     ORDER BY nc.check_date`,
    [compartmentId, siteId, excludeCheckId, `${year}-01-01`, `${year}-12-31`],
  );
}

export async function deleteLocalEntry(id: string): Promise<void> {
  const D = await db();
  await D.runAsync('DELETE FROM nest_check_entries WHERE id = ?', [id]);
  await D.runAsync('DELETE FROM bands WHERE nest_check_entry_id = ?', [id]);
}

export async function getPendingEntries(): Promise<LocalEntry[]> {
  const D = await db();
  return D.getAllAsync<LocalEntry>(
    "SELECT * FROM nest_check_entries WHERE sync_status = 'pending'",
  );
}

export async function markEntrySynced(id: string): Promise<void> {
  const D = await db();
  await D.runAsync("UPDATE nest_check_entries SET sync_status = 'synced' WHERE id = ?", [id]);
}

// ── Nestlings ─────────────────────────────────────────────────────────

export async function cacheNestlings(
  nestlings: { id: string; compartment_id: string; site_season_id: string; label: string }[],
): Promise<void> {
  const D = await db();
  for (const N of nestlings) {
    await D.runAsync(
      "INSERT OR IGNORE INTO nestlings (id, compartment_id, site_season_id, label, sync_status) VALUES (?,?,?,?,'synced')",
      [N.id, N.compartment_id, N.site_season_id, N.label],
    );
  }
}

export async function upsertLocalNestling(N: {
  id: string; compartment_id: string; site_season_id: string; label: string;
}): Promise<void> {
  const D = await db();
  await D.runAsync(
    "INSERT OR REPLACE INTO nestlings (id, compartment_id, site_season_id, label, sync_status) VALUES (?,?,?,?,'pending')",
    [N.id, N.compartment_id, N.site_season_id, N.label],
  );
}

export async function getLocalNestlings(
  compartmentId: string, seasonId: string,
): Promise<{ id: string; label: string }[]> {
  const D = await db();
  return D.getAllAsync<{ id: string; label: string }>(
    'SELECT id, label FROM nestlings WHERE compartment_id = ? AND site_season_id = ? ORDER BY rowid',
    [compartmentId, seasonId],
  );
}

export async function getPendingNestlings(): Promise<{
  id: string; compartment_id: string; site_season_id: string; label: string;
}[]> {
  const D = await db();
  return D.getAllAsync(
    "SELECT id, compartment_id, site_season_id, label FROM nestlings WHERE sync_status = 'pending'",
  );
}

export async function markNestlingSynced(localId: string, serverId?: string): Promise<void> {
  const D = await db();
  if (serverId && serverId !== localId) {
    await D.runAsync("UPDATE nestlings SET id = ?, sync_status = 'synced' WHERE id = ?", [serverId, localId]);
    await D.runAsync('UPDATE bands SET nestling_id = ? WHERE nestling_id = ?', [serverId, localId]);
  } else {
    await D.runAsync("UPDATE nestlings SET sync_status = 'synced' WHERE id = ?", [localId]);
  }
}

// ── Bands ─────────────────────────────────────────────────────────────

export async function cacheBands(
  bands: {
    id?: string; nest_check_entry_id: string; nestling_id?: string | null;
    is_new_banding: boolean; bird_type: string; band_type: string;
    band_color: string | null; band_code: string;
  }[],
): Promise<void> {
  const D = await db();
  for (const B of bands) {
    await D.runAsync(
      "INSERT OR IGNORE INTO bands (id,nest_check_entry_id,nestling_id,is_new_banding,bird_type,band_type,band_color,band_code,sync_status) VALUES (?,?,?,?,?,?,?,?,'synced')",
      [B.id ?? makeId(), B.nest_check_entry_id, B.nestling_id ?? null,
       B.is_new_banding ? 1 : 0, B.bird_type, B.band_type, B.band_color ?? null, B.band_code],
    );
  }
}

export async function replaceLocalBands(
  entryId: string,
  bands: {
    id: string; nestling_id: string | null; is_new_banding: boolean;
    bird_type: string; band_type: string; band_color: string | null; band_code: string;
  }[],
): Promise<void> {
  const D = await db();
  await D.runAsync('DELETE FROM bands WHERE nest_check_entry_id = ?', [entryId]);
  for (const B of bands) {
    await D.runAsync(
      "INSERT INTO bands (id,nest_check_entry_id,nestling_id,is_new_banding,bird_type,band_type,band_color,band_code,sync_status) VALUES (?,?,?,?,?,?,?,?,'pending')",
      [B.id, entryId, B.nestling_id, B.is_new_banding ? 1 : 0,
       B.bird_type, B.band_type, B.band_color ?? null, B.band_code],
    );
  }
}

export async function getLocalBands(entryId: string): Promise<{
  nestling_id: string | null; is_new_banding: number;
  bird_type: string; band_type: string; band_color: string | null; band_code: string;
}[]> {
  const D = await db();
  return D.getAllAsync(
    'SELECT nestling_id, is_new_banding, bird_type, band_type, band_color, band_code FROM bands WHERE nest_check_entry_id = ?',
    [entryId],
  );
}

export async function getLocalBandEntryIds(entryIds: string[]): Promise<Set<string>> {
  if (entryIds.length === 0) return new Set();
  const D = await db();
  const ph = entryIds.map(() => '?').join(',');
  const rows = await D.getAllAsync<{ nest_check_entry_id: string }>(
    `SELECT DISTINCT nest_check_entry_id FROM bands WHERE nest_check_entry_id IN (${ph})`,
    entryIds,
  );
  return new Set(rows.map(r => r.nest_check_entry_id));
}

export async function getLocalPriorBandCounts(
  nestlingIds: string[], excludeEntryId: string | null,
): Promise<Map<string, number>> {
  if (nestlingIds.length === 0) return new Map();
  const D = await db();
  const ph = nestlingIds.map(() => '?').join(',');
  const params: (string | null)[] = [...nestlingIds];
  let sql = `SELECT nestling_id, COUNT(*) as cnt FROM bands WHERE nestling_id IN (${ph})`;
  if (excludeEntryId) { sql += ' AND nest_check_entry_id != ?'; params.push(excludeEntryId); }
  sql += ' GROUP BY nestling_id';
  const rows = await D.getAllAsync<{ nestling_id: string; cnt: number }>(sql, params);
  return new Map(rows.map(r => [r.nestling_id, r.cnt]));
}

export async function getLocalPriorBandDetails(
  nestlingId: string, excludeEntryId: string | null,
): Promise<{ band_type: string; band_color: string | null; band_code: string; check_date: string }[]> {
  const D = await db();
  const params: string[] = [nestlingId];
  let sql = `
    SELECT b.band_type, b.band_color, b.band_code, nc.check_date
    FROM bands b
    JOIN nest_check_entries nce ON nce.id = b.nest_check_entry_id
    JOIN nest_checks nc ON nc.id = nce.nest_check_id
    WHERE b.nestling_id = ?
  `;
  if (excludeEntryId) { sql += ' AND b.nest_check_entry_id != ?'; params.push(excludeEntryId); }
  sql += ' ORDER BY nc.check_date';
  return D.getAllAsync(sql, params);
}

export async function getPendingBandEntryIds(): Promise<string[]> {
  const D = await db();
  const rows = await D.getAllAsync<{ nest_check_entry_id: string }>(
    "SELECT DISTINCT nest_check_entry_id FROM bands WHERE sync_status = 'pending'",
  );
  return rows.map(r => r.nest_check_entry_id);
}

export async function getAllBandsForEntry(entryId: string): Promise<any[]> {
  const D = await db();
  return D.getAllAsync('SELECT * FROM bands WHERE nest_check_entry_id = ?', [entryId]);
}

export async function markBandsSyncedForEntry(entryId: string): Promise<void> {
  const D = await db();
  await D.runAsync("UPDATE bands SET sync_status = 'synced' WHERE nest_check_entry_id = ?", [entryId]);
}

// ── Nest seasons ──────────────────────────────────────────────────────

export async function cacheNestSeasons(
  rows: { compartment_id: string; site_season_id: string; male_age: string | null; female_age: string | null }[],
): Promise<void> {
  const D = await db();
  for (const NS of rows) {
    const existing = await D.getFirstAsync<{ id: string; sync_status: string }>(
      'SELECT id, sync_status FROM nest_seasons WHERE compartment_id = ? AND site_season_id = ?',
      [NS.compartment_id, NS.site_season_id],
    );
    if (!existing) {
      await D.runAsync(
        "INSERT INTO nest_seasons (id,compartment_id,site_season_id,male_age,female_age,sync_status) VALUES (?,?,?,?,?,'synced')",
        [makeId(), NS.compartment_id, NS.site_season_id, NS.male_age ?? null, NS.female_age ?? null],
      );
    } else if (existing.sync_status === 'synced') {
      // Only overwrite if not locally pending
      await D.runAsync(
        'UPDATE nest_seasons SET male_age = ?, female_age = ? WHERE id = ?',
        [NS.male_age ?? null, NS.female_age ?? null, existing.id],
      );
    }
  }
}

export async function upsertLocalNestSeason(data: {
  compartment_id: string; site_season_id: string; year: number;
  male_age: string | null; female_age: string | null;
}): Promise<void> {
  const D = await db();
  const existing = await D.getFirstAsync<{ id: string }>(
    'SELECT id FROM nest_seasons WHERE compartment_id = ? AND site_season_id = ?',
    [data.compartment_id, data.site_season_id],
  );
  if (existing) {
    await D.runAsync(
      "UPDATE nest_seasons SET year = ?, male_age = ?, female_age = ?, sync_status = 'pending' WHERE id = ?",
      [data.year, data.male_age, data.female_age, existing.id],
    );
  } else {
    await D.runAsync(
      "INSERT INTO nest_seasons (id,compartment_id,site_season_id,year,male_age,female_age,sync_status) VALUES (?,?,?,?,?,?,'pending')",
      [makeId(), data.compartment_id, data.site_season_id, data.year, data.male_age, data.female_age],
    );
  }
}

export async function getLocalNestSeasons(
  seasonId: string,
): Promise<{ compartment_id: string; male_age: string | null; female_age: string | null }[]> {
  const D = await db();
  return D.getAllAsync(
    'SELECT compartment_id, male_age, female_age FROM nest_seasons WHERE site_season_id = ?',
    [seasonId],
  );
}

export async function getPendingNestSeasons(): Promise<{
  id: string; compartment_id: string; site_season_id: string;
  year: number | null; male_age: string | null; female_age: string | null;
}[]> {
  const D = await db();
  return D.getAllAsync(
    "SELECT id, compartment_id, site_season_id, year, male_age, female_age FROM nest_seasons WHERE sync_status = 'pending'",
  );
}

export async function markNestSeasonSynced(id: string): Promise<void> {
  const D = await db();
  await D.runAsync("UPDATE nest_seasons SET sync_status = 'synced' WHERE id = ?", [id]);
}

// ── Pending count (for the sync badge) ───────────────────────────────

export async function lookupLocalBandLocation(bandCode: string): Promise<{
  unit: string; cavity: string; date: string;
} | null> {
  const D = await db();
  const row = await D.getFirstAsync<{ unit_name: string; cavity_label: string; check_date: string }>(`
    SELECT hu.name AS unit_name, c.cavity_label, nc.check_date
    FROM bands b
    JOIN nest_check_entries nce ON nce.id = b.nest_check_entry_id
    JOIN nest_checks nc         ON nc.id  = nce.nest_check_id
    JOIN compartments c         ON c.id   = nce.compartment_id
    JOIN housing_units hu       ON hu.id  = c.housing_unit_id
    WHERE b.band_code = ? AND b.is_new_banding = 1
    LIMIT 1
  `, [bandCode]);
  if (!row) return null;
  return { unit: row.unit_name, cavity: row.cavity_label, date: row.check_date };
}

export async function getPendingCount(): Promise<number> {
  const D = await db();
  const results = await Promise.all([
    D.getFirstAsync<{ n: number }>("SELECT COUNT(*) as n FROM nest_checks WHERE sync_status = 'pending'"),
    D.getFirstAsync<{ n: number }>("SELECT COUNT(*) as n FROM nest_check_entries WHERE sync_status = 'pending'"),
    D.getFirstAsync<{ n: number }>("SELECT COUNT(*) as n FROM nestlings WHERE sync_status = 'pending'"),
    D.getFirstAsync<{ n: number }>("SELECT COUNT(DISTINCT nest_check_entry_id) as n FROM bands WHERE sync_status = 'pending'"),
    D.getFirstAsync<{ n: number }>("SELECT COUNT(*) as n FROM nest_seasons WHERE sync_status = 'pending'"),
  ]);
  return results.reduce((sum, r) => sum + (r?.n ?? 0), 0);
}
