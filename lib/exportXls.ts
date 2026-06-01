import ExcelJS from 'exceljs';
import * as FileSystem from 'expo-file-system/legacy';
import { Share } from 'react-native';
import { supabase } from './supabase';

// ── Color constants (ARGB, alpha always FF) ───────────────────────────────────
const C = {
  PURPLE: 'FFCC99FF',  // header row
  GRAY:   'FFC0C0C0',  // site/season info
  PINK:   'FFFF99CC',  // age codes
  CYAN:   'FFCCFFFF',  // house codes
  PEACH:  'FFFFCC99',  // hole type codes
  YELLOW: 'FFFFFF99',  // martin codes
};

function fill(argb: string): ExcelJS.FillPattern {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function styled(cell: ExcelJS.Cell, argb: string, bold = false) {
  cell.fill = fill(argb);
  cell.font = { bold, name: 'Arial' };
}

// ── Data helpers ───────────────────────────────────────────────────────────────
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

// ── Info / legend block ────────────────────────────────────────────────────────
// ExcelJS uses 1-based row/col indices. Info block original positions (0-indexed)
// map to (0-indexed + 1) in ExcelJS.
function addInfoBlock(ws: ExcelJS.Worksheet, colA: number, year: number, siteName: string) {
  // colA is 0-indexed from our logic; ExcelJS needs 1-indexed
  const ca = colA + 1;
  const cb = ca + 1;

  function ic(r0: number, col: number, value: string, argb: string, bold = false) {
    const cell = ws.getCell(r0 + 1, col);  // r0 is 0-indexed
    cell.value = value;
    styled(cell, argb, bold);
  }

  // Site/season info (rows 2–8, gray)
  const siteRows: [number, string, string][] = [
    [2, 'Season:',        String(year)],
    [3, 'Name:',          ''],
    [4, 'Address:',       ''],
    [5, 'City:',          ''],
    [6, 'State:',         ''],
    [7, 'Zip:',           ''],
    [8, 'Site location:', siteName],
  ];
  for (const [r, label, val] of siteRows) {
    ic(r, ca, label, C.GRAY, true);
    ic(r, cb, val,   C.GRAY, false);
  }

  // Age Codes (row 10 bold header, rows 11–19 pink data)
  {
    const cell = ws.getCell(11, ca);
    cell.value = 'Age Codes';
    cell.font = { bold: true, name: 'Arial' };
  }
  const ageCodes: [string, string][] = [
    ['ASY/ASY', 'Adult male / adult female'],
    ['ASY/SY',  'Adult male / subadult female'],
    ['SY/ASY',  'Subadult male / adult female'],
    ['SY/SY',   'Subadult male / subadult female'],
    ['UNK/ASY', 'Unknown male / adult female'],
    ['ASY/UNK', 'Adult male / unknown female'],
    ['UNK/SY',  'Unknown male / subadult female'],
    ['SY/UNK',  'Subadult male / unknown female'],
    ['UNK/UNK', 'Unknown male / unknown female'],
  ];
  for (let i = 0; i < ageCodes.length; i++) {
    ic(11 + i, ca, ageCodes[i][0], C.PINK);
    ic(11 + i, cb, ageCodes[i][1], C.PINK);
  }

  // House Codes (row 21 bold header, rows 22–26 cyan data)
  ic(21, ca, 'House Code',  C.CYAN, true);
  ic(21, cb, 'Description', C.CYAN, true);
  const houseCodes: [string, string][] = [
    ['WH', 'Wooden House'],
    ['MH', 'Metal House'],
    ['PH', 'Plastic House'],
    ['NG', 'Natural Gourd'],
    ['AG', 'Artificial Gourd'],
  ];
  for (let i = 0; i < houseCodes.length; i++) {
    ic(22 + i, ca, houseCodes[i][0], C.CYAN);
    ic(22 + i, cb, houseCodes[i][1], C.CYAN);
  }

  // Hole Type Codes (row 29 bold header, rows 30–33 peach data)
  ic(29, ca, 'Hole Type Code', C.PEACH, true);
  ic(29, cb, 'Description',    C.PEACH, true);
  const holeCodes: [string, string][] = [
    ['RH', 'Round Hole'],
    ['CH', 'Crescent Hole, including Clinger entrance'],
    ['EH', 'Excluder Hole, including Connelly entrance'],
    ['OH', 'Obround Hole'],
  ];
  for (let i = 0; i < holeCodes.length; i++) {
    ic(30 + i, ca, holeCodes[i][0], C.PEACH);
    ic(30 + i, cb, holeCodes[i][1], C.PEACH);
  }

  // Martin Codes (row 36 bold header, rows 37–53 yellow data)
  ic(36, ca, 'Martin Codes', C.YELLOW, true);
  ic(36, cb, '',             C.YELLOW, true);
  const martinCodes = [
    'X=Empty Cavity', 'N=Nest', 'E=Egg(s)', 'Y=Young (living)',
    '3do=Young 3 days old', 'HD=Hatching Day', 'DY=Dead Young',
    'NR=Nest Replaced', 'D=Discarded', 'B=Banded', 'RA=Renesting Attempt',
    'PM=Purple Martin', 'HS=House Sparrow', 'ST=Starling',
    'TS=Tree Swallow', 'BB=Bluebird', 'HW=House Wren',
  ];
  for (let i = 0; i < martinCodes.length; i++) {
    ic(37 + i, ca, martinCodes[i], C.YELLOW);
  }
}

// ── Main export ────────────────────────────────────────────────────────────────
export async function exportSeasonXls(
  SeasonId: string,
  SiteId: string,
  Year: number,
): Promise<string | null> {
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
    .select('nest_check_id, compartment_id, species, egg_count, young_count, nestling_age_days, nest_discarded, compartments(cavity_label, housing_type, hole_type, housing_units(name))')
    .in('nest_check_id', Checks.map(c => c.id));

  const { data: NestSeasons } = await supabase
    .from('nest_seasons')
    .select('compartment_id, male_age, female_age')
    .eq('site_season_id', SeasonId);

  if (!Entries) return 'Failed to load nest data.';

  const AgeMap = new Map<string, { male_age: string | null; female_age: string | null }>();
  if (NestSeasons) {
    for (const NS of NestSeasons) AgeMap.set(NS.compartment_id, NS);
  }

  type CompData = {
    unit_name: string; label: string;
    housing_type: string; hole_type: string;
    byCheck: Map<string, EntryData>;
  };
  const CompMap = new Map<string, CompData>();

  for (const E of Entries) {
    const comp = E.compartments as any;
    if (!comp) continue;
    if (!CompMap.has(E.compartment_id)) {
      CompMap.set(E.compartment_id, {
        unit_name:    (comp.housing_units as any)?.name ?? '',
        label:        comp.cavity_label as string,
        housing_type: (comp.housing_type as string) ?? '',
        hole_type:    (comp.hole_type as string) ?? '',
        byCheck:      new Map(),
      });
    }
    CompMap.get(E.compartment_id)!.byCheck.set(E.nest_check_id, {
      species:           E.species ?? null,
      egg_count:         E.egg_count ?? 0,
      young_count:       E.young_count ?? 0,
      nestling_age_days: E.nestling_age_days ?? null,
      nest_discarded:    E.nest_discarded ?? false,
    });
  }

  const SortedComps = [...CompMap.entries()].sort(([, a], [, b]) => {
    const u = a.unit_name.localeCompare(b.unit_name);
    return u !== 0 ? u : a.label.localeCompare(b.label);
  });

  // ── Build workbook ─────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`${Year} Nest Data`);

  // Column widths
  ws.getColumn(1).width = 12;   // Housing Type
  ws.getColumn(2).width = 10;   // Hole Type
  ws.getColumn(3).width = 10;   // Cavity number
  ws.getColumn(4).width = 12;   // Age
  ws.getColumn(5).width = 16;   // First Egg
  ws.getColumn(6).width = 12;   // Total Eggs
  ws.getColumn(7).width = 16;   // Proj Hatch
  ws.getColumn(8).width = 14;   // Actual Hatch
  ws.getColumn(9).width = 20;   // Fledge
  for (let i = 0; i < Checks.length; i++) ws.getColumn(10 + i).width = 8;
  ws.getColumn(10 + Checks.length).width = 6;
  ws.getColumn(11 + Checks.length).width = 6;
  ws.getColumn(12 + Checks.length).width = 6;

  // Header row (purple, bold)
  const headerValues = [
    'Housing Type', 'Hole Type', 'Cavity number', 'Male/Female Age',
    'Date First Egg is Laid', 'Total # Eggs Laid', 'Projected Hatch Date',
    'Actual Hatch Date', 'Earliest Possible Fledge Date',
    ...Checks.map(c => fmtDate(c.check_date)),
    'Egg #', 'Hatch #', 'Fledge #',
  ];
  const headerRow = ws.addRow(headerValues);
  headerRow.eachCell({ includeEmpty: true }, cell => styled(cell, C.PURPLE, true));

  // Data rows
  for (const [CompId, Data] of SortedComps) {
    const Ages = AgeMap.get(CompId);
    const AgeStr = Ages ? [Ages.male_age, Ages.female_age].filter(Boolean).join('/') : '';

    const EWD = Checks.map(c => ({ date: c.check_date, entry: Data.byCheck.get(c.id) ?? null }))
      .filter(({ entry }) => entry?.species === 'PM');

    let FirstEggDate = '', MaxEggs = 0, ProjHatch = '', ActualHatch = '', ProjFledge = '', HatchCount = 0;

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

    ws.addRow([
      Data.housing_type, Data.hole_type, Data.label, AgeStr,
      FirstEggDate, MaxEggs || '', ProjHatch, ActualHatch, ProjFledge,
      ...Checks.map(c => checkCode(Data.byCheck.get(c.id) ?? null)),
      MaxEggs || '', HatchCount || '', '',
    ]);
  }

  // Info / legend block (2 cols after Fledge #)
  const InfoCol0 = 9 + Checks.length + 5;  // 0-indexed; addInfoBlock converts to 1-indexed
  addInfoBlock(ws, InfoCol0, Year, SiteName);

  // ── Write & share ──────────────────────────────────────────────────
  const SafeName = SiteName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const FilePath = `${FileSystem.documentDirectory}PurpleSkies_${SafeName}_${Year}.xlsx`;

  const arrayBuffer = await wb.xlsx.writeBuffer() as ArrayBuffer;
  const uint8 = new Uint8Array(arrayBuffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < uint8.length; i += CHUNK) {
    binary += String.fromCharCode(...uint8.subarray(i, Math.min(i + CHUNK, uint8.length)));
  }
  const base64 = btoa(binary);

  await FileSystem.writeAsStringAsync(FilePath, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });

  await Share.share({ url: FilePath, title: `${SiteName} ${Year} Nest Data` });

  return null;
}
