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
  discarded_eggs: number;
  young_count: number;
  nestling_age_days: number | null;
  nest_discarded: boolean;
  has_banding: boolean;
  fledged_count: number;
  gourd_removed: boolean;
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
  const sp = entry.species;
  const isPM = sp === 'PM';
  if (entry.nest_discarded) return isPM ? 'ND' : `${sp}ND`;
  let code = '';
  if (!isPM) {
    const parts = [
      entry.egg_count > 0    ? `${entry.egg_count}E`    : '',
      entry.young_count > 0  ? `${entry.young_count}Y`  : '',
      entry.discarded_eggs > 0 ? `${entry.discarded_eggs}ED` : '',
    ].filter(Boolean).join(' ');
    code = parts ? `${sp} ${parts}` : `${sp}N`;
  } else {
    if (entry.young_count > 0) {
      const age = entry.nestling_age_days != null
        ? ` ${entry.nestling_age_days === 0 ? 'HD' : `${entry.nestling_age_days}do`}`
        : '';
      code = `${entry.young_count}Y${age}`;
    } else if (entry.egg_count > 0 || entry.discarded_eggs > 0) {
      const parts = [
        entry.egg_count > 0      ? `${entry.egg_count}E`      : '',
        entry.discarded_eggs > 0 ? `${entry.discarded_eggs}ED` : '',
      ].filter(Boolean).join(' ');
      code = parts;
    } else {
      code = 'PMN';
    }
    if (entry.has_banding) code += ' B';
  }
  if (entry.gourd_removed) code += ' GR';
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
  bird_label:     string;
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
    'X=Empty Cavity', 'N=Nest', 'E=Egg(s)', 'ED=Eggs Discarded', 'Y=Young (living)',
    '3do=Young 3 days old', 'HD=Hatching Day', 'DY=Dead Young',
    'NR=Nest Replaced', 'ND=Nest Discarded', 'B=Banded', 'RA=Renesting Attempt',
    'GR=Gourd Removed',
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
      const bird  = B.bird_label;
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
    .select('id, nest_check_id, compartment_id, species, adult_present, egg_count, discarded_eggs, young_count, nestling_age_days, nest_discarded, fledged_count, nesting_attempt, gourd_removed, compartments(cavity_label, housing_type, hole_type, housing_units(name))')
    .in('nest_check_id', Checks.map(c => c.id));

  const BandingSet = new Set<string>();
  const BandDetails: BandDetail[] = [];
  if (Entries && Entries.length > 0) {
    const { data: BandRows } = await supabase
      .from('bands')
      .select('nest_check_entry_id, nestling_id, is_new_banding, bird_type, band_type, band_color, band_code')
      .in('nest_check_entry_id', Entries.map(e => e.id));
    if (BandRows) {
      // Fetch labels for any nestlings referenced
      const NestlingIds = [...new Set(BandRows.map((B: any) => B.nestling_id).filter(Boolean))];
      const NestlingLabelMap = new Map<string, string>();
      if (NestlingIds.length > 0) {
        const { data: NestlingRows } = await supabase
          .from('nestlings').select('id, label').in('id', NestlingIds);
        if (NestlingRows) for (const N of NestlingRows) NestlingLabelMap.set(N.id, N.label);
      }

      for (const B of BandRows as any[]) {
        BandingSet.add(B.nest_check_entry_id);
        const Entry = Entries.find(e => e.id === B.nest_check_entry_id);
        if (!Entry) continue;
        const Check = Checks.find(c => c.id === Entry.nest_check_id);
        const comp  = Entry.compartments as any;
        const bird_label = B.nestling_id
          ? (NestlingLabelMap.get(B.nestling_id) ?? 'Nestling')
          : B.bird_type === 'adult_male' ? 'Adult M' : 'Adult F';
        BandDetails.push({
          cavity_label:   comp?.cavity_label ?? '',
          check_date:     Check?.check_date  ?? '',
          bird_label,
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
    compartment_id: string;
    unit_name: string; label: string;
    housing_type: string; hole_type: string;
    nesting_attempt: number;
    byCheck: Map<string, EntryData>;
  };
  // Keyed by `${compartment_id}:${nesting_attempt}` so each attempt gets its own row
  const CompMap = new Map<string, CompData>();

  // Full PM egg history per compartment (all attempts) for RA first-egg uncertainty
  const AllHistoryByCompartment = new Map<string, { check_date: string; egg_count: number; discarded_eggs: number }[]>();

  for (const E of Entries) {
    const comp = E.compartments as any;
    if (!comp) continue;
    const Attempt = (E as any).nesting_attempt ?? 1;
    const Key = `${E.compartment_id}:${Attempt}`;
    if (!CompMap.has(Key)) {
      CompMap.set(Key, {
        compartment_id: E.compartment_id,
        unit_name:      (comp.housing_units as any)?.name ?? '',
        label:          comp.cavity_label as string,
        housing_type:   (comp.housing_type as string) ?? '',
        hole_type:      (comp.hole_type as string) ?? '',
        nesting_attempt: Attempt,
        byCheck:        new Map(),
      });
    }
    if (!(E as any).adult_present) {
      CompMap.get(Key)!.byCheck.set(E.nest_check_id, {
        species:           E.species ?? null,
        egg_count:         E.egg_count ?? 0,
        discarded_eggs:    (E as any).discarded_eggs ?? 0,
        young_count:       E.young_count ?? 0,
        nestling_age_days: E.nestling_age_days ?? null,
        nest_discarded:    E.nest_discarded ?? false,
        has_banding:       BandingSet.has(E.id),
        fledged_count:     (E as any).fledged_count ?? 0,
        gourd_removed:     !!(E as any).gourd_removed,
      });
    }

    // Accumulate PM egg history for trough-aware first-egg calculation (skip not-checked entries)
    if (E.species === 'PM' && !(E as any).adult_present) {
      const Chk = Checks.find(c => c.id === E.nest_check_id);
      if (Chk) {
        if (!AllHistoryByCompartment.has(E.compartment_id)) AllHistoryByCompartment.set(E.compartment_id, []);
        const hist = AllHistoryByCompartment.get(E.compartment_id)!;
        if (!hist.some(h => h.check_date === Chk.check_date))
          hist.push({ check_date: Chk.check_date, egg_count: E.egg_count ?? 0, discarded_eggs: (E as any).discarded_eggs ?? 0 });
      }
    }
  }
  for (const [id, hist] of AllHistoryByCompartment)
    AllHistoryByCompartment.set(id, hist.sort((a, b) => a.check_date.localeCompare(b.check_date)));

  // Track the most recent check date where gourd_removed was recorded per compartment
  const GourdRemovedDate = new Map<string, string>();
  for (const E of Entries) {
    if ((E as any).gourd_removed) {
      const Chk = Checks.find(c => c.id === E.nest_check_id);
      if (Chk) {
        const existing = GourdRemovedDate.get(E.compartment_id);
        if (!existing || Chk.check_date > existing) {
          GourdRemovedDate.set(E.compartment_id, Chk.check_date);
        }
      }
    }
  }

  // Compartments that have at least one renesting attempt row
  const MultiAttemptCompartments = new Set<string>();
  for (const [, Data] of CompMap) {
    if (Data.nesting_attempt > 1) MultiAttemptCompartments.add(Data.compartment_id);
  }

  const numericLocale = (a: string, b: string) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

  const SortedComps = [...CompMap.entries()].sort(([, a], [, b]) => {
    const u = numericLocale(a.unit_name, b.unit_name);
    if (u !== 0) return u;
    const l = numericLocale(a.label, b.label);
    if (l !== 0) return l;
    return a.nesting_attempt - b.nesting_attempt;
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

  for (const [, Data] of SortedComps) {
    const IsRA = Data.nesting_attempt > 1;
    const Ages = AgeMap.get(Data.compartment_id);
    const AgeStr = Ages ? [Ages.male_age, Ages.female_age].filter(Boolean).join('/') : '';

    const EWD = Checks.map(c => ({ date: c.check_date, entry: Data.byCheck.get(c.id) ?? null }))
      .filter(({ entry }) => entry?.species === 'PM');

    let FirstEggDate = '', MaxEggs = 0, ProjHatch = '', ActualHatch = '', ProjFledge = '', HatchCount = 0;

    const FirstWithEggs = EWD.find(({ entry }) => (entry?.egg_count ?? 0) > 0);
    if (FirstWithEggs?.entry) {
      MaxEggs = Math.max(...EWD.map(({ entry }) => entry?.egg_count ?? 0));
      const LatestFirst = addDays(FirstWithEggs.date, -(FirstWithEggs.entry.egg_count - 1));
      let EarliestFirst: string | null = null;

      if (!IsRA) {
        // First attempt: last check with 0 eggs gives the lower bound
        const LastEmpty = [...EWD]
          .filter(({ entry, date }) => (entry?.egg_count ?? 0) === 0 && date < FirstWithEggs.date)
          .pop();
        EarliestFirst = LastEmpty ? addDays(LastEmpty.date, 1) : null;
      } else {
        // Renesting: trough eggs may include new ones; go back before trough if trough count > 0
        const Hist = AllHistoryByCompartment.get(Data.compartment_id) ?? [];
        const Before = Hist.filter(h => h.check_date < FirstWithEggs.date);
        const Trough = Before[Before.length - 1] ?? null;
        if (Trough) {
          const TroughNet = Math.max(0, Trough.egg_count - Trough.discarded_eggs);
          if (TroughNet === 0) {
            EarliestFirst = addDays(Trough.check_date, 1);
          } else {
            const PreTrough = Before[Before.length - 2] ?? null;
            EarliestFirst = addDays(PreTrough ? PreTrough.check_date : Trough.check_date, 1);
          }
        }
      }

      const MinFirst = (EarliestFirst && EarliestFirst <= LatestFirst) ? EarliestFirst : LatestFirst;
      FirstEggDate = fmtDate(MinFirst);
      ProjHatch = fmtDate(addDays(MinFirst, MaxEggs - 1 + 15));
    }

    // nestling_age_days can be 0 on hatch day, so use != null rather than > 0
    const Anchor = EWD.find(({ entry }) => (entry?.young_count ?? 0) > 0 && entry?.nestling_age_days != null);
    if (Anchor?.entry) {
      const [ay, am, ad] = Anchor.date.split('-').map(Number);
      const HatchDt = new Date(ay, am - 1, ad);
      HatchDt.setDate(HatchDt.getDate() - Anchor.entry.nestling_age_days!);
      const HatchIso = `${HatchDt.getFullYear()}-${String(HatchDt.getMonth() + 1).padStart(2, '0')}-${String(HatchDt.getDate()).padStart(2, '0')}`;
      ActualHatch = fmtDate(HatchIso);
      ProjFledge  = fmtDate(addDays(HatchIso, 26));
    }

    HatchCount = EWD.length > 0 ? Math.max(...EWD.map(({ entry }) => entry?.young_count ?? 0)) : 0;
    const FledgeCount = EWD.reduce((sum, { entry }) => sum + (entry?.fledged_count ?? 0), 0);

    // For multi-attempt compartments, show blank for checks belonging to a different attempt.
    // For gourd-removed compartments, show blank for subsequent checks with no entry.
    const GourdDate = GourdRemovedDate.get(Data.compartment_id);
    const CheckCodes = Checks.map(c => {
      if (Data.byCheck.has(c.id)) return checkCode(Data.byCheck.get(c.id)!);
      if (GourdDate && c.check_date > GourdDate) return '';
      if (MultiAttemptCompartments.has(Data.compartment_id)) return '';
      return checkCode(null);
    });

    DataRows.push([
      Data.housing_type,
      Data.hole_type,
      IsRA ? `${Data.label} (RA)` : Data.label,
      AgeStr,
      FirstEggDate, MaxEggs || '', ProjHatch, ActualHatch, ProjFledge,
      ...CheckCodes,
      MaxEggs || '', HatchCount || '', FledgeCount || '',
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
  const FilePath = `${FileSystem.documentDirectory}PurpleSkies_${SafeName}_${Year}.xls`;
  const Base64 = XLSX.write(wb, { type: 'base64', bookType: 'biff8', cellStyles: true });

  await FileSystem.writeAsStringAsync(FilePath, Base64, {
    encoding: FileSystem.EncodingType.Base64,
  });

  await Share.share({ url: FilePath, title: `${SiteName} ${Year} Nest Data` });

  return null;
}
