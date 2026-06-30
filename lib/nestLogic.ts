// Pure business logic — no React Native, Supabase, or SQLite dependencies.
// Extracted here so it can be unit-tested without mocking native modules.

// Increments the last run of digits in a band code, preserving leading zeros.
// e.g. "2841-74209" → "2841-74210",  "TX 403" → "TX 404",  "Red" → "Red"
export function incrementBandCode(code: string): string {
  const m = /\d+(?=\D*$)/.exec(code);
  if (!m) return code;
  const incremented = (parseInt(m[0], 10) + 1).toString().padStart(m[0].length, '0');
  return code.slice(0, m.index) + incremented + code.slice(m.index + m[0].length);
}

// Returns an error string if the federal band code is invalid, or null if valid.
// Valid: digits and at most one dash, total 8-9 digits.
export function validateFederalBandCode(code: string): string | null {
  const digits = code.replace(/-/g, '');
  if (!/^\d+$/.test(digits)) return 'Federal band number may only contain digits and an optional dash.';
  if (digits.length < 8) return `Federal band numbers must be 8 or 9 digits (you entered ${digits.length}).`;
  if (digits.length > 9) return `Federal band numbers must be 8 or 9 digits (you entered ${digits.length}).`;
  return null;
}

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
  // Walk observations in chronological order. Whichever age most recently crossed
  // a multiple of 3 becomes the confirmed age — so a replacement bird whose age
  // accumulates 3 later observations overrides an earlier confirmation.
  const counts: Record<string, number> = {};
  let result: string | null = null;
  for (const O of [...others, current]) {
    if (!O) continue;
    counts[O] = (counts[O] ?? 0) + 1;
    if (counts[O] % 3 === 0) result = O;
  }
  return result;
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

export function buildEntrySummary(entry: EntrySummaryInput): string | null {
  if (entry.is_empty_cavity) return 'Empty cavity';
  if (entry.adult_present)   return 'Adult present · not checked';
  const effectivelyHasNest = entry.has_nest ||
    (entry.egg_count ?? 0) > 0 ||
    (entry.young_count ?? 0) > 0 ||
    (entry.fledged_count ?? 0) > 0 ||
    (entry.discarded_eggs ?? 0) > 0 ||
    entry.nest_discarded;
  if (!effectivelyHasNest) {
    const obsParts: string[] = [];
    if (entry.male_age)   obsParts.push(`♂ ${entry.male_age}`);
    if (entry.female_age) obsParts.push(`♀ ${entry.female_age}`);
    if (entry.has_banding) obsParts.push('B');
    return obsParts.length > 0 ? obsParts.join(' · ') : null;
  }
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

// Running-floor egg sum: counts every new egg laid above the current net-egg floor,
// so discards + re-lays within one nesting attempt are captured correctly.
export function calcTotalEggsLaid(checks: Array<{
  egg_count: number;
  discarded_eggs: number;
  is_empty_cavity: boolean;
  nest_discarded: boolean;
}>): number {
  let floor = 0;
  let total = 0;
  for (const c of checks) {
    if (c.is_empty_cavity || c.nest_discarded) { floor = 0; continue; }
    const net = Math.max(0, c.egg_count - c.discarded_eggs);
    if (net > floor) total += net - floor;
    floor = net;
  }
  return total;
}

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
