import { supabase } from './supabase';
import {
  getPendingNestChecks, markNestCheckSynced,
  getPendingEntries, markEntrySynced,
  getPendingNestlings, markNestlingSynced,
  getPendingBandEntryIds, getAllBandsForEntry, markBandsSyncedForEntry,
  getPendingNestSeasons, markNestSeasonSynced,
} from './localDb';

export { getPendingCount } from './localDb';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const INTER_RECORD_DELAY_MS = 100;

// Push all locally-pending records to Supabase in dependency order.
// Each record is pushed independently — a failure on one doesn't block the rest.
export async function pushPending(): Promise<void> {
  await pushPendingNestChecks();
  await pushPendingEntries();
  await pushPendingNestlings();
  await pushPendingBands();
  await pushPendingNestSeasons();
}

async function pushPendingNestChecks() {
  const checks = await getPendingNestChecks();
  for (const C of checks) {
    const { error } = await supabase.from('nest_checks').upsert({
      id: C.id, site_id: C.site_id, check_date: C.check_date, created_by: C.created_by,
    });
    if (!error) await markNestCheckSynced(C.id);
    await pause(INTER_RECORD_DELAY_MS);
  }
}

async function pushPendingEntries() {
  const entries = await getPendingEntries();
  for (const E of entries) {
    const { error } = await supabase.from('nest_check_entries').upsert({
      id: E.id,
      nest_check_id: E.nest_check_id,
      compartment_id: E.compartment_id,
      species: E.species,
      is_empty_cavity:  !!E.is_empty_cavity,
      has_nest:         !!E.has_nest,
      nest_discarded:   !!E.nest_discarded,
      nest_replaced:    !!E.nest_replaced,
      egg_count:        E.egg_count,
      discarded_eggs:   E.discarded_eggs,
      young_count:      E.young_count,
      nestling_age_days:   E.nestling_age_days,
      nestling_age_notes:  E.nestling_age_notes,
      dead_young_count:    E.dead_young_count,
      dead_adult_male:     !!E.dead_adult_male,
      dead_adult_female:   !!E.dead_adult_female,
      fledged_count:       E.fledged_count,
      renesting_attempt:   !!E.renesting_attempt,
      notes:               E.notes,
      observed_male_age:   E.observed_male_age,
      observed_female_age: E.observed_female_age,
      gourd_removed:       !!E.gourd_removed,
    });
    if (!error) await markEntrySynced(E.id);
    await pause(INTER_RECORD_DELAY_MS);
  }
}

async function pushPendingNestlings() {
  const nestlings = await getPendingNestlings();
  for (const N of nestlings) {
    const { error } = await supabase.from('nestlings').upsert({
      id: N.id, compartment_id: N.compartment_id,
      site_season_id: N.site_season_id, label: N.label,
    });
    if (!error) await markNestlingSynced(N.id);
    await pause(INTER_RECORD_DELAY_MS);
  }
}

async function pushPendingBands() {
  const entryIds = await getPendingBandEntryIds();
  for (const entryId of entryIds) {
    const bands = await getAllBandsForEntry(entryId);
    // Mirror the delete-then-reinsert strategy used by NestCheckEntry
    await supabase.from('bands').delete().eq('nest_check_entry_id', entryId);
    if (bands.length > 0) {
      const { error } = await supabase.from('bands').insert(
        bands.map((B: any) => ({
          id:                  B.id,
          nest_check_entry_id: B.nest_check_entry_id,
          nestling_id:         B.nestling_id,
          is_new_banding:      !!B.is_new_banding,
          bird_type:           B.bird_type,
          band_type:           B.band_type,
          band_color:          B.band_color,
          band_code:           B.band_code,
        })),
      );
      if (!error) await markBandsSyncedForEntry(entryId);
    } else {
      await markBandsSyncedForEntry(entryId);
    }
    await pause(INTER_RECORD_DELAY_MS);
  }
}

async function pushPendingNestSeasons() {
  const rows = await getPendingNestSeasons();
  for (const NS of rows) {
    const { data: existing } = await supabase
      .from('nest_seasons').select('id')
      .eq('compartment_id', NS.compartment_id)
      .eq('site_season_id', NS.site_season_id)
      .maybeSingle();

    let error;
    if (existing) {
      ({ error } = await supabase.from('nest_seasons')
        .update({ male_age: NS.male_age, female_age: NS.female_age })
        .eq('id', existing.id));
    } else {
      ({ error } = await supabase.from('nest_seasons').insert({
        compartment_id: NS.compartment_id,
        site_season_id: NS.site_season_id,
        year: NS.year,
        male_age: NS.male_age,
        female_age: NS.female_age,
      }));
    }
    if (!error) await markNestSeasonSynced(NS.id);
    await pause(INTER_RECORD_DELAY_MS);
  }
}
