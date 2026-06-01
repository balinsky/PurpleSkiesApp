import * as XLSX from 'xlsx';
import * as FileSystem from 'expo-file-system/legacy';
import { Share } from 'react-native';
import { supabase } from './supabase';

type EntryData = {
  species: string | null;
  egg_count: number;
  young_count: number;
  nestling_age_days: number | null;
  nest_discarded: boolean;
};

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}/${y}`;
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function checkCode(entry: EntryData | null): string {
  if (!entry || !entry.species) return 'X';
  if (entry.nest_discarded) return 'D';
  if (entry.species !== 'PM') {
    const parts = [
      entry.egg_count > 0 ? `${entry.egg_count}E` : '',
      entry.young_count > 0 ? `${entry.young_count}Y` : '',
    ].filter(Boolean).join(' ');
    return parts ? `${entry.species} ${parts}` : entry.species;
  }
  if (entry.young_count > 0) {
    const age = entry.nestling_age_days != null ? ` ${entry.nestling_age_days}do` : '';
    return `${entry.young_count}Y${age}`;
  }
  if (entry.egg_count > 0) return `${entry.egg_count}E`;
  return 'N';
}

export async function exportSeasonXls(
  SeasonId: string,
  SiteId: string,
  Year: number,
): Promise<string | null> {
  // ── Fetch data ─────────────────────────────────────────────────────
  const [{ data: Checks }, { data: SiteData }] = await Promise.all([
    supabase
      .from('nest_checks')
      .select('id, check_date')
      .eq('site_id', SiteId)
      .gte('check_date', `${Year}-01-01`)
      .lte('check_date', `${Year}-12-31`)
      .order('check_date', { ascending: true }),
    supabase.from('sites').select('name').eq('id', SiteId).single(),
  ]);

  if (!Checks || Checks.length === 0) return 'No nest checks found for this season.';
  const SiteName = (SiteData as any)?.name ?? 'Site';

  const { data: Entries } = await supabase
    .from('nest_check_entries')
    .select('nest_check_id, compartment_id, species, egg_count, young_count, nestling_age_days, nest_discarded, compartments(cavity_label, housing_units(name))')
    .in('nest_check_id', Checks.map(c => c.id));

  const { data: NestSeasons } = await supabase
    .from('nest_seasons')
    .select('compartment_id, male_age, female_age')
    .eq('site_season_id', SeasonId);

  if (!Entries) return 'Failed to load nest data.';

  // ── Build compartment map ──────────────────────────────────────────
  const AgeMap = new Map<string, { male_age: string | null; female_age: string | null }>();
  if (NestSeasons) {
    for (const NS of NestSeasons) AgeMap.set(NS.compartment_id, NS);
  }

  type CompData = { unit_name: string; label: string; byCheck: Map<string, EntryData> };
  const CompMap = new Map<string, CompData>();

  for (const E of Entries) {
    const comp = E.compartments as any;
    if (!comp) continue;
    if (!CompMap.has(E.compartment_id)) {
      CompMap.set(E.compartment_id, {
        unit_name: (comp.housing_units as any)?.name ?? '',
        label: comp.cavity_label as string,
        byCheck: new Map(),
      });
    }
    CompMap.get(E.compartment_id)!.byCheck.set(E.nest_check_id, {
      species:          E.species ?? null,
      egg_count:        E.egg_count ?? 0,
      young_count:      E.young_count ?? 0,
      nestling_age_days: E.nestling_age_days ?? null,
      nest_discarded:   E.nest_discarded ?? false,
    });
  }

  const SortedComps = [...CompMap.entries()].sort(([, a], [, b]) => {
    const u = a.unit_name.localeCompare(b.unit_name);
    return u !== 0 ? u : a.label.localeCompare(b.label);
  });

  // ── Header row ─────────────────────────────────────────────────────
  const HeaderRow = [
    'Housing Type', 'Hole Type', 'Cavity number', 'Male/Female Age',
    'Date First Egg is Laid', 'Total # Eggs Laid', 'Projected Hatch Date',
    'Actual Hatch Date', 'Earliest Possible Fledge Date',
    ...Checks.map(c => fmtDate(c.check_date)),
    'Egg #', 'Hatch #', 'Fledge #',
  ];

  // ── Data rows ──────────────────────────────────────────────────────
  const DataRows = SortedComps.map(([CompId, Data]) => {
    const Ages = AgeMap.get(CompId);
    const AgeStr = Ages
      ? [Ages.male_age, Ages.female_age].filter(Boolean).join('/')
      : '';

    // PM-specific timeline
    const EWD = Checks.map(c => ({ date: c.check_date, entry: Data.byCheck.get(c.id) ?? null }))
      .filter(({ entry }) => entry?.species === 'PM');

    let FirstEggDate = '';
    let MaxEggs = 0;
    let ProjHatch = '';
    let ActualHatch = '';
    let ProjFledge = '';
    let HatchCount = 0;

    const FirstWithEggs = EWD.find(({ entry }) => (entry?.egg_count ?? 0) > 0);
    if (FirstWithEggs?.entry) {
      const LastEmpty = [...EWD]
        .filter(({ entry, date }) => (entry?.egg_count ?? 0) === 0 && date < FirstWithEggs.date)
        .pop();
      MaxEggs = Math.max(...EWD.map(({ entry }) => entry?.egg_count ?? 0));
      const LatestFirst = addDays(FirstWithEggs.date, -(FirstWithEggs.entry.egg_count - 1));
      const EarliestFirst = LastEmpty ? addDays(LastEmpty.date, 1) : null;
      const MinFirst = (EarliestFirst && EarliestFirst <= LatestFirst) ? EarliestFirst : LatestFirst;
      FirstEggDate = fmtDate(MinFirst);
      ProjHatch = fmtDate(addDays(MinFirst, MaxEggs - 1 + 15));
    }

    const Anchor = EWD.find(({ entry }) => (entry?.young_count ?? 0) > 0 && (entry?.nestling_age_days ?? 0) > 0);
    if (Anchor?.entry) {
      const [ay, am, ad] = Anchor.date.split('-').map(Number);
      const HatchDt = new Date(ay, am - 1, ad);
      HatchDt.setDate(HatchDt.getDate() - Anchor.entry.nestling_age_days!);
      const HatchIso = `${HatchDt.getFullYear()}-${String(HatchDt.getMonth() + 1).padStart(2, '0')}-${String(HatchDt.getDate()).padStart(2, '0')}`;
      ActualHatch = fmtDate(HatchIso);
      ProjFledge  = fmtDate(addDays(HatchIso, 26));
    }

    HatchCount = EWD.length > 0 ? Math.max(...EWD.map(({ entry }) => entry?.young_count ?? 0)) : 0;

    return [
      Data.unit_name,
      '',
      Data.label,
      AgeStr,
      FirstEggDate,
      MaxEggs || '',
      ProjHatch,
      ActualHatch,
      ProjFledge,
      ...Checks.map(c => checkCode(Data.byCheck.get(c.id) ?? null)),
      MaxEggs || '',
      HatchCount || '',
      '',
    ];
  });

  // ── Build workbook ─────────────────────────────────────────────────
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([HeaderRow, ...DataRows]);

  const colWidths = [
    { wch: 18 }, { wch: 10 }, { wch: 10 }, { wch: 12 },
    { wch: 16 }, { wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 20 },
    ...Checks.map(() => ({ wch: 8 })),
    { wch: 6 }, { wch: 6 }, { wch: 6 },
  ];
  ws['!cols'] = colWidths;

  XLSX.utils.book_append_sheet(wb, ws, `${Year} Nest Data`);

  // ── Write & share ──────────────────────────────────────────────────
  const SafeName = SiteName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const FilePath = `${FileSystem.documentDirectory}PurpleSkies_${SafeName}_${Year}.xlsx`;
  const Base64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
  await FileSystem.writeAsStringAsync(FilePath, Base64, {
    encoding: FileSystem.EncodingType.Base64,
  });

  await Share.share({ url: FilePath, title: `${SiteName} ${Year} Nest Data` });

  return null;
}
