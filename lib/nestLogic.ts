// Pure business logic — no React Native, Supabase, or SQLite dependencies.
// Extracted here so it can be unit-tested without mocking native modules.

export const SpeciesLabel: Record<string, string> = {
  PM: 'Purple Martin', HS: 'House Sparrow', ST: 'Starling',
  TS: 'Tree Swallow',  BB: 'Bluebird',      HW: 'House Wren',
};

export function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export function computeConfirmedAge(others: (string | null)[], current: string | null): string | null {
  const Counts: Record<string, number> = {};
  for (const O of [...others, current]) if (O) Counts[O] = (Counts[O] ?? 0) + 1;
  for (const [Age, N] of Object.entries(Counts)) if (N >= 3) return Age;
  return null;
}

export function netEggs(eggCount: number, discardedEggs: number): number {
  return Math.max(0, eggCount - discardedEggs);
}

export type EntrySummaryInput = {
  species: string;
  is_empty_cavity: boolean;
  has_nest: boolean;
  nest_discarded: boolean;
  adult_present?: boolean;
  egg_count: number;
  discarded_eggs: number;
  young_count: number;
  nestling_age_days: number | null;
  fledged_count?: number;
  renesting_attempt?: boolean;
  male_age?: string | null;
  female_age?: string | null;
  has_banding?: boolean;
  gourd_removed?: boolean;
};

export function buildEntrySummary(entry: EntrySummaryInput): string {
  if (entry.is_empty_cavity) return 'Empty cavity';
  if (entry.adult_present)   return 'Adult present · not checked';
  if (!entry.has_nest)       return 'Unchecked';
  const IsPM = entry.species === 'PM';
  const SpeciesName = SpeciesLabel[entry.species] ?? entry.species;
  const NetEggs = Math.max(0, entry.egg_count - entry.discarded_eggs);
  const Parts: string[] = [];
  if (!IsPM || (NetEggs === 0 && entry.young_count === 0 && entry.discarded_eggs === 0)) {
    Parts.push(`${SpeciesName} nest`);
  } else {
    Parts.push(SpeciesName);
    if (entry.egg_count > 0 && entry.discarded_eggs > 0) {
      Parts.push(`${entry.egg_count} ${entry.egg_count === 1 ? 'egg' : 'eggs'}, ${entry.discarded_eggs} discarded`);
    } else if (NetEggs > 0) {
      Parts.push(`${NetEggs} ${NetEggs === 1 ? 'egg' : 'eggs'}`);
    }
    if (entry.young_count > 0) {
      Parts.push(`${entry.young_count} young`);
      if (entry.nestling_age_days === 0)        Parts.push('HD');
      else if (entry.nestling_age_days != null) Parts.push(`${entry.nestling_age_days}do`);
    }
  }
  if ((entry.fledged_count ?? 0) > 0) Parts.push(`${entry.fledged_count} fledged`);
  if (entry.nest_discarded)           Parts.push('discarded');
  if (entry.renesting_attempt)        Parts.push('RA');
  if (IsPM) {
    const AgeParts = [
      entry.male_age   && `♂ ${entry.male_age}`,
      entry.female_age && `♀ ${entry.female_age}`,
    ].filter(Boolean);
    if (AgeParts.length > 0) Parts.push(AgeParts.join(' '));
  }
  if (entry.has_banding)    Parts.push('B');
  if (entry.gourd_removed)  Parts.push('Gourd removed');
  return Parts.join(' · ');
}

export type FledgeParams = {
  isPM: boolean;
  prevYoungCount: number | null;
  prevNestingAttempt: number | null;
  currentNestingAttempt: number;
  youngCount: number;
  calculatedNestlingAge: number | null;
  nestlingAgeDays: number;
  isHatchingDay: boolean;
  fledgedCount: number;
  hasDeadYoung: boolean;
  deadYoungCount: number;
};

// Returns the full reduction count to prompt fledging, or 0 if no prompt is needed.
export function fledgeUnaccounted(p: FledgeParams): number {
  if (!p.isPM) return 0;
  if (p.prevYoungCount == null || p.prevYoungCount <= 0) return 0;
  if (p.prevNestingAttempt !== p.currentNestingAttempt) return 0;
  const Reduction = p.prevYoungCount - p.youngCount;
  if (Reduction <= 0) return 0;
  const Age = p.calculatedNestlingAge ??
    (p.youngCount > 0 && !p.isHatchingDay ? p.nestlingAgeDays : null);
  if (Age === null || Age < 26) return 0;
  const Accounted = p.fledgedCount + (p.hasDeadYoung ? p.deadYoungCount : 0);
  return Reduction - Accounted > 0 ? Reduction : 0;
}
