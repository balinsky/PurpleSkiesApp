import XLSX from 'xlsx-js-style';
import * as FileSystem from 'expo-file-system/legacy';
import { Share } from 'react-native';
import { supabase } from './supabase';

// ── Style helpers ─────────────────────────────────────────────────────────────
// xlsx-js-style uses 6-char RGB (no #), ARGB is not needed
const solidFill = (rgb: string) => ({ patternType: 'solid', fgColor: { rgb } });

const hdrAlign = { wrapText: true,  horizontal: 'center', vertical: 'bottom' };
const hdrAlign2 = { wrapText: false, horizontal: 'center', vertical: 'bottom' };

const S = {
  header:      { fill: solidFill('CC99FF'), font: { bold: true,  name: 'Arial', sz: 11 }, alignment: hdrAlign  },
  headerLight: { fill: solidFill('CC99FF'), font: { bold: false, name: 'Arial', sz: 11 }, alignment: hdrAlign2 },
  grayBold:   { fill: solidFill('C0C0C0'), font: { bold: true,  name: 'Arial' } },
  gray:       { fill: solidFill('C0C0C0'), font: { bold: false, name: 'Arial' } },
  boldOnly:   {                            font: { bold: true,  name: 'Arial' } },
  pink:       { fill: solidFill('FF99CC'), font: { bold: false, name: 'Arial' } },
  cyanBold:   { fill: solidFill('CCFFFF'), font: { bold: true,  name: 'Arial' } },
  cyan:       { fill: solidFill('CCFFFF'), font: { bold: false, name: 'Arial' } },
  peachBold:  { fill: solidFill('FFCC99'), font: { bold: true,  name: 'Arial' } },
  peach:      { fill: solidFill('FFCC99'), font: { bold: false, name: 'Arial' } },
  yellowBold: { fill: solidFill('FFFF99'), font: { bold: true,  name: 'Arial' } },
  yellow:     { fill: solidFill('FFFF99'), font: { bold: false, name: 'Arial' } },
  greenBold:  { fill: solidFill('CCFFCC'), font: { bold: true,  name: 'Arial' } },
  green:      { fill: solidFill('CCFFCC'), font: { bold: false, name: 'Arial' } },
};

// ── Worksheet cell helpers ─────────────────────────────────────────────────────
function setCell(ws: any, c: number, r: number, v: string, s?: object) {
  const addr = XLSX.utils.encode_cell({ c, r });
  ws[addr] = { t: 's', v, ...(s ? { s } : {}) };
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
  if (c > range.e.c) range.e.c = c;
  if (r > range.e.r) range.e.r = r;
  ws['!ref'] = XLSX.utils.encode_range(range);
}

function applyStyle(ws: any, c: number, r: number, s: object) {
  const addr = XLSX.utils.encode_cell({ c, r });
  if (ws[addr]) ws[addr].s = s;
}

// ── Data helpers ───────────────────────────────────────────────────────────────
type EntryData = {
  species: string | null;
  egg_count: number;
  young_count: number;
  nestling_age_days: number | null;
  nest_discarded: boolean;
  has_banding: boolean;
};

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

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
  let code = '';
  if (entry.young_count > 0) {
    const age = entry.nestling_age_days != null ? ` ${entry.nestling_age_days}do` : '';
    code = `${entry.young_count}Y${age}`;
  } else if (entry.egg_count > 0) {
    code = `${entry.egg_count}E`;
  } else {
    code = 'N';
  }
  if (entry.has_banding) code += ' B';
  return code;
}

// ── Info / legend block ────────────────────────────────────────────────────────
type SiteContact = {
  contact_name:    string | null;
  contact_address: string | null;
  contact_city:    string | null;
  contact_state:   string | null;
  contact_zip:     string | null;
};

type BandDetail = {
  cavity_label:   string;
  check_date:     string;
  bird_type:      string;
  is_new_banding: boolean;
  band_type:      string;
  band_color:     string | null;
  band_code:      string;
};

function addInfoBlock(ws: any, colA: number, year: number, siteName: string, contact: SiteContact, bandDetails: BandDetail[]) {
  const colB = colA + 1;

  const siteRows: [number, string, string][] = [
    [2, 'Season:',        String(year)],
    [3, 'Name:',          contact.contact_name    ?? ''],
    [4, 'Address:',       contact.contact_address ?? ''],
    [5, 'City:',          contact.contact_city    ?? ''],
    [6, 'State:',         contact.contact_state   ?? ''],
    [7, 'Zip:',           contact.contact_zip     ?? ''],
    [8, 'Site location:', siteName],
  ];
  for (const [r, label, val] of siteRows) {
    setCell(ws, colA, r, label, S.grayBold);
    setCell(ws, colB, r, val,   S.gray);
  }

  setCell(ws, colA, 10, 'Age Codes', S.boldOnly);
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
    setCell(ws, colA, 11 + i, ageCodes[i][0], S.pink);
    setCell(ws, colB, 11 + i, ageCodes[i][1], S.pink);
  }

  setCell(ws, colA, 21, 'House Code',  S.cyanBold);
  setCell(ws, colB, 21, 'Description', S.cyanBold);
  const houseCodes: [string, string][] = [
    ['WH', 'Wooden House'],
    ['MH', 'Metal House'],
    ['PH', 'Plastic House'],
    ['NG', 'Natural Gourd'],
    ['AG', 'Artificial Gourd'],
  ];
  for (let i = 0; i < houseCodes.length; i++) {
    setCell(ws, colA, 22 + i, houseCodes[i][0], S.cyan);
    setCell(ws, colB, 22 + i, houseCodes[i][1], S.cyan);
  }

  setCell(ws, colA, 29, 'Hole Type Code', S.peachBold);
  setCell(ws, colB, 29, 'Description',    S.peachBold);
  const holeCodes: [string, string][] = [
    ['RH', 'Round Hole'],
    ['CH', 'Crescent Hole, including Clinger entrance'],
    ['EH', 'Excluder Hole, including Connelly entrance'],
    ['OH', 'Obround Hole'],
  ];
  for (let i = 0; i < holeCodes.length; i++) {
    setCell(ws, colA, 30 + i, holeCodes[i][0], S.peach);
    setCell(ws, colB, 30 + i, holeCodes[i][1], S.peach);
  }

  setCell(ws, colA, 36, 'Martin Codes', S.yellowBold);
  setCell(ws, colB, 36, '',             S.yellowBold);
  const martinCodes = [
    'X=Empty Cavity', 'N=Nest', 'E=Egg(s)', 'Y=Young (living)',
    '3do=Young 3 days old', 'HD=Hatching Day', 'DY=Dead Young',
    'NR=Nest Replaced', 'D=Discarded', 'B=Banded', 'RA=Renesting Attempt',
    'PM=Purple Martin', 'HS=House Sparrow', 'ST=Starling',
    'TS=Tree Swallow', 'BB=Bluebird', 'HW=House Wren',
  ];
  for (let i = 0; i < martinCodes.length; i++) {
    setCell(ws, colA, 37 + i, martinCodes[i], S.yellow);
  }

  if (bandDetails.length > 0) {
    const bandStart = 55;
    setCell(ws, colA, bandStart,     'Banding Records', S.greenBold);
    setCell(ws, colB, bandStart,     '',                S.greenBold);
    setCell(ws, colA, bandStart + 1, 'Cavity · Date · Bird', S.greenBold);
    setCell(ws, colB, bandStart + 1, 'Event · Band',         S.greenBold);
    for (let i = 0; i < bandDetails.length; i++) {
      const B = bandDetails[i];
      const bird  = B.bird_type === 'nestling' ? 'Nestling'
                  : B.bird_type === 'adult_male' ? 'Adult M' : 'Adult F';
      const event = B.is_new_banding ? 'New' : 'Observed';
      const band  = B.band_type === 'federal'
                  ? `Federal ${B.band_code}`
                  : `${B.band_color ? B.band_color + ' ' : ''}${B.band_code}`;
      setCell(ws, colA, bandStart + 2 + i, `${B.cavity_label} · ${fmtDate(B.check_date)} · ${bird}`, S.green);
      setCell(ws, colB, bandStart + 2 + i, `${event} · ${band}`, S.green);
    }
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
    supabase.from('sites').select('name, contact_name, contact_address, contact_city, contact_state, contact_zip').eq('id', SiteId).single(),
  ]);

  if (!Checks || Checks.length === 0) return 'No nest checks found for this season.';
  const SiteName = (SiteData as any)?.name ?? 'Site';
  const Contact: SiteContact = {
    contact_name:    (SiteData as any)?.contact_name    ?? null,
    contact_address: (SiteData as any)?.contact_address ?? null,
    contact_city:    (SiteData as any)?.contact_city    ?? null,
    contact_state:   (SiteData as any)?.contact_state   ?? null,
    contact_zip:     (SiteData as any)?.contact_zip     ?? null,
  };

  const { data: Entries } = await supabase
    .from('nest_check_entries')
    .select('id, nest_check_id, compartment_id, species, egg_count, young_count, nestling_age_days, nest_discarded, compartments(cavity_label, housing_type, hole_type, housing_units(name))')
    .in('nest_check_id', Checks.map(c => c.id));

  const BandingSet = new Set<string>();
  const BandDetails: BandDetail[] = [];
  if (Entries && Entries.length > 0) {
    const { data: BandRows } = await supabase
      .from('bands')
      .select('nest_check_entry_id, is_new_banding, bird_type, band_type, band_color, band_code')
      .in('nest_check_entry_id', Entries.map(e => e.id));
    if (BandRows) {
      for (const B of BandRows) {
        BandingSet.add(B.nest_check_entry_id);
        const Entry = Entries.find(e => e.id === B.nest_check_entry_id);
        if (!Entry) continue;
        const Check = Checks.find(c => c.id === Entry.nest_check_id);
        const comp  = Entry.compartments as any;
        BandDetails.push({
          cavity_label:   comp?.cavity_label ?? '',
          check_date:     Check?.check_date  ?? '',
          bird_type:      B.bird_type,
          is_new_banding: B.is_new_banding,
          band_type:      B.band_type,
          band_color:     B.band_color ?? null,
          band_code:      B.band_code,
        });
      }
      BandDetails.sort((a, b) => {
        const d = a.check_date.localeCompare(b.check_date);
        return d !== 0 ? d : a.cavity_label.localeCompare(b.cavity_label);
      });
    }
  }

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
      has_banding:       BandingSet.has(E.id),
    });
  }

  const SortedComps = [...CompMap.entries()].sort(([, a], [, b]) => {
    const u = a.unit_name.localeCompare(b.unit_name);
    return u !== 0 ? u : a.label.localeCompare(b.label);
  });

  // ── Build worksheet ────────────────────────────────────────────────
  // Row 1: labels + ordinal check placeholders (purple, bold)
  const HeaderRow1 = [
    'Housing Type', 'Hole Type', 'Cavity number', 'Male/Female Age',
    'Date First Egg is Laid', 'Total # Eggs Laid', 'Projected Hatch Date',
    'Actual Hatch Date', 'Earliest Possible Fledge Date',
    ...Checks.map((_, i) => `Enter date of ${ordinal(i + 1)} nest check here:`),
    'Egg #', 'Hatch #', 'Fledge #',
  ];
  // Row 2: blank for A–I, actual dates for check columns, blank for summary (purple, not bold)
  const HeaderRow2 = [
    '', '', '', '', '', '', '', '', '',
    ...Checks.map(c => fmtDate(c.check_date)),
    '', '', '',
  ];

  const DataRows: (string | number)[][] = [];

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

    DataRows.push([
      Data.housing_type, Data.hole_type, Data.label, AgeStr,
      FirstEggDate, MaxEggs || '', ProjHatch, ActualHatch, ProjFledge,
      ...Checks.map(c => checkCode(Data.byCheck.get(c.id) ?? null)),
      MaxEggs || '', HatchCount || '', '',
    ]);
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([HeaderRow1, HeaderRow2, ...DataRows]);

  ws['!cols'] = [
    { wch: 11 },  // Housing Type
    { wch: 9  },  // Hole Type
    { wch: 11 },  // Cavity number
    { wch: 15 },  // Male/Female Age
    { wch: 14 },  // Date First Egg
    { wch: 14 },  // Total # Eggs
    { wch: 13 },  // Projected Hatch
    { wch: 9  },  // Actual Hatch
    { wch: 14 },  // Earliest Fledge
    ...Checks.map(() => ({ wch: 14 })),
    { wch: 9  },  // Egg #
    { wch: 9  },  // Hatch #
    { wch: 11 },  // Fledge #
  ];
  ws['!rows'] = [
    { hpt: 47.2 },  // row 1: tall wrapped header
    { hpt: 12   },  // row 2: check dates
  ];

  // Style both header rows
  for (let c = 0; c < HeaderRow1.length; c++) {
    applyStyle(ws, c, 0, S.header);
    applyStyle(ws, c, 1, S.headerLight);
  }

  // Info / legend block (2 cols after Fledge #)
  const InfoCol = 9 + Checks.length + 4;
  addInfoBlock(ws, InfoCol, Year, SiteName, Contact, BandDetails);

  XLSX.utils.book_append_sheet(wb, ws, `${Year} Nest Data`);

  // ── Write & share ──────────────────────────────────────────────────
  const SafeName = SiteName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const FilePath = `${FileSystem.documentDirectory}PurpleSkies_${SafeName}_${Year}.xlsx`;
  const Base64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx', cellStyles: true });

  await FileSystem.writeAsStringAsync(FilePath, Base64, {
    encoding: FileSystem.EncodingType.Base64,
  });

  await Share.share({ url: FilePath, title: `${SiteName} ${Year} Nest Data` });

  return null;
}
