import XLSX from 'xlsx-js-style';
import * as FileSystem from 'expo-file-system/legacy';

// ── Types ──────────────────────────────────────────────────────────────────────

export type ImportEntryData = {
  species: string;
  is_empty_cavity: boolean;
  has_nest: boolean;
  nest_discarded: boolean;
  egg_count: number;
  discarded_eggs: number;
  young_count: number;
  nestling_age_days: number | null;
  dead_young_count: number;
  dead_adult_sex: 'M' | 'F' | 'U' | null;
  gourd_removed: boolean;
  has_banding: boolean;
  notes: string | null;
};

export type ParseCodeError = { ok: false; raw: string; reason: string };
export type ParseCodeOk    = { ok: true;  data: ImportEntryData };
export type ParseCodeResult = ParseCodeOk | ParseCodeError;

export type ImportRow = {
  rowIndex: number;
  unit_name: string;          // resolved housing unit name
  housing_type: string;
  hole_type: string;
  cavity_label: string;       // bare label, no " (RA)"
  nesting_attempt: number;
  male_age: string | null;
  female_age: string | null;
  checks: { date: string; result: ParseCodeResult }[];
  stated_eggs: number | null;      // from "Egg #" summary column
  stated_hatch: number | null;     // from "Hatch #" summary column
  stated_fledge: number | null;    // from "Fledge #" summary column
  total_eggs_laid: number | null;  // from "Total # Eggs Laid" computed column
};

export type ImportError = {
  row: number;
  date: string;    // empty string for row-level errors
  raw: string;
  reason: string;
};

export type ImportSummary = {
  year: number;
  check_dates: string[];       // ISO YYYY-MM-DD
  rows: ImportRow[];
  errors: ImportError[];
};

// ── Check code parser ──────────────────────────────────────────────────────────

const KNOWN_SPECIES = ['PM', 'HS', 'ST', 'TS', 'BB', 'HW'];

export function parseCheckCode(raw: string): ParseCodeResult {
  const sOrig = raw.trim();
  const s     = sOrig.toUpperCase();

  // Codes are matched case-insensitively (toUpperCase handles 5e, 3y, hd, 3do, etc.).
  // Unrecognized tokens are collected as notes with their original case.

  if (!s || s === 'X') {
    return {
      ok: true,
      data: {
        species: 'PM', is_empty_cavity: true, has_nest: false, nest_discarded: false,
        egg_count: 0, discarded_eggs: 0, young_count: 0, nestling_age_days: null,
        dead_young_count: 0, dead_adult_sex: null, gourd_removed: false, has_banding: false,
        notes: null,
      },
    };
  }

  // Detect and strip species prefix.
  // Accept the prefix when followed by: end-of-string, space, digit, or a content-starting letter.
  let rest = s;
  let species = 'PM';
  for (const sp of KNOWN_SPECIES) {
    if (rest.startsWith(sp)) {
      const after = rest[sp.length];
      if (after === undefined || after === ' ' || /[\dNDEYXGBH]/.test(after)) {
        species = sp;
        rest = rest.slice(sp.length).trimStart();
        break;
      }
    }
  }

  // Parallel original-case rest string for note extraction (toUpperCase is length-preserving for ASCII)
  const consumed = s.length - rest.length;
  const restOrig = sOrig.slice(consumed);

  let is_empty_cavity = false;
  let has_nest = false;
  let nest_discarded = false;
  let egg_count = 0;
  let discarded_eggs = 0;
  let young_count = 0;
  let nestling_age_days: number | null = null;
  let dead_young_count = 0;
  let dead_adult_sex: 'M' | 'F' | 'U' | null = null;
  let gourd_removed = false;
  let has_banding = false;

  if (!rest) {
    // Bare species code (e.g. "PM") — treat as nest only for PM, unknown otherwise
    if (species === 'PM') has_nest = true;
    return { ok: true, data: { species, is_empty_cavity, has_nest, nest_discarded, egg_count, discarded_eggs, young_count, nestling_age_days, dead_young_count, dead_adult_sex, gourd_removed, has_banding, notes: null } };
  }

  // Tokenize on whitespace AND split fused patterns like 3Y2E or 4YHD.
  // Priority order ensures longest/most-specific match wins (e.g. DYD before DY, ED before E).
  const TOKEN_RE = /\d+DYD|\d+DY|\d+DO|\d+ED|\d+E|\d+Y|\d+B|[A-Z]+|\d+/g;
  const toks: Array<{ t: string; start: number }> = [];
  let m2: RegExpExecArray | null;
  while ((m2 = TOKEN_RE.exec(rest)) !== null) toks.push({ t: m2[0], start: m2.index });
  const noteWords: string[] = [];
  let i = 0;

  while (i < toks.length) {
    const t = toks[i].t;

    if (t === 'X')                { is_empty_cavity = true;       i++; continue; }
    if (t === 'N' || t === 'PMN') { has_nest = true;              i++; continue; }
    if (t === 'ND' || t === 'D')  { nest_discarded = true;        i++; continue; }
    if (t === 'B')                { has_banding = true;           i++; continue; }
    if (t === 'GR')               { gourd_removed = true;         i++; continue; }
    if (t === 'DADM')             { dead_adult_sex = 'M';         i++; continue; }
    if (t === 'DADF')             { dead_adult_sex = 'F';         i++; continue; }
    if (t === 'DAD')              { dead_adult_sex = 'U';         i++; continue; }
    if (t === 'HD')               { nestling_age_days = 0;        i++; continue; }

    // {n}E — eggs
    let m = t.match(/^(\d+)E$/);
    if (m) { egg_count = parseInt(m[1], 10); has_nest = true; i++; continue; }

    // {n}ED — discarded eggs
    m = t.match(/^(\d+)ED$/);
    if (m) { discarded_eggs = parseInt(m[1], 10); i++; continue; }

    // {n}Y — young, optionally followed by HD or {d}DO
    m = t.match(/^(\d+)Y$/);
    if (m) {
      young_count = parseInt(m[1], 10);
      has_nest = true;
      if (i + 1 < toks.length) {
        if (toks[i + 1].t === 'HD') { nestling_age_days = 0; i += 2; continue; }
        const am = toks[i + 1].t.match(/^(\d+)DO$/);
        if (am) { nestling_age_days = parseInt(am[1], 10); i += 2; continue; }
      }
      i++; continue;
    }

    // {n}B — young count with banding (PMCA standard: "4B" = 4 young banded)
    m = t.match(/^(\d+)B$/);
    if (m) { young_count = parseInt(m[1], 10); has_banding = true; has_nest = true; i++; continue; }

    // {n}DY or {n}DYD — dead young
    m = t.match(/^(\d+)DYD?$/);
    if (m) { dead_young_count = parseInt(m[1], 10); i++; continue; }

    // {n}DO — age in days (standalone, no Y prefix)
    m = t.match(/^(\d+)DO$/);
    if (m) { nestling_age_days = parseInt(m[1], 10); i++; continue; }

    // Unrecognized token → treat as free-text note (preserve original case)
    noteWords.push(restOrig.slice(toks[i].start, toks[i].start + toks[i].t.length));
    i++;
  }

  // {n}ED alone → all found were discarded → egg_count = discarded_eggs
  if (discarded_eggs > 0 && egg_count === 0) {
    egg_count = discarded_eggs;
  }

  if (discarded_eggs > egg_count) {
    return { ok: false, raw, reason: `Discarded eggs (${discarded_eggs}) > total eggs (${egg_count})` };
  }

  const notes = noteWords.length > 0 ? noteWords.join(' ') : null;
  return { ok: true, data: { species, is_empty_cavity, has_nest, nest_discarded, egg_count, discarded_eggs, young_count, nestling_age_days, dead_young_count, dead_adult_sex, gourd_removed, has_banding, notes } };
}

// ── Unit name helpers ──────────────────────────────────────────────────────────

function defaultUnitName(housingTypeCode: string): string {
  const names: Record<string, string> = {
    WH: 'Wooden House', MH: 'Metal House', PH: 'Plastic House',
    NG: 'Natural Gourd Rack', AG: 'Artificial Gourd Rack',
  };
  return names[housingTypeCode.toUpperCase()] ?? housingTypeCode;
}

// ── Numeric cell helper ────────────────────────────────────────────────────────

function parseIntCell(val: unknown): number | null {
  if (val == null || String(val).trim() === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// ── Date helpers ───────────────────────────────────────────────────────────────

function excelSerialToISO(serial: number): string {
  // Excel epoch is 1900-01-00; 25569 = days between Excel epoch and Unix epoch
  const d = new Date(Math.round((serial - 25569) * 86400 * 1000));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function parseDate(val: unknown): string | null {
  // xlsx-js-style returns date cells as raw serial numbers when no cellDates option is set
  if (typeof val === 'number' && val > 1000) return excelSerialToISO(val);
  const m = String(val).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mo, dy, yr] = m.map(Number);
  if (mo < 1 || mo > 12 || dy < 1 || dy > 31) return null;
  return `${yr}-${String(mo).padStart(2, '0')}-${String(dy).padStart(2, '0')}`;
}

// ── File parser ────────────────────────────────────────────────────────────────

export async function parseImportFile(uri: string): Promise<ImportSummary | string> {
  // Read file as base64
  let base64: string;
  try {
    base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  } catch (e: any) {
    return `Could not read file: ${e?.message ?? e}`;
  }

  let ws: any;
  try {
    const wb = XLSX.read(base64, { type: 'base64' });
    ws = wb.Sheets[wb.SheetNames[0]];
  } catch (e: any) {
    return `Could not parse file: ${e?.message ?? e}`;
  }

  const raw: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as string[][];
  if (raw.length < 3) return 'File has no data rows.';

  const header1 = raw[0] ?? [];
  const header2 = raw[1] ?? [];

  // Find check columns: header row 1 contains "Enter date of"
  const checkColIndices: number[] = [];
  for (let c = 0; c < header1.length; c++) {
    if (String(header1[c]).toLowerCase().includes('enter date of')) checkColIndices.push(c);
  }

  if (checkColIndices.length === 0) {
    return 'No check date columns found. Make sure the file uses the Purple Skies export format.';
  }

  // Detect optional stated-summary columns and the computed total-eggs column
  let statedEggsCol = -1, statedHatchCol = -1, statedFledgeCol = -1, totalEggsLaidCol = -1;
  for (let c = 0; c < header1.length; c++) {
    const h = String(header1[c]).trim();
    if (h === 'Egg #') statedEggsCol = c;
    else if (h === 'Hatch #') statedHatchCol = c;
    else if (h === 'Fledge #') statedFledgeCol = c;
    else if (h === 'Total # Eggs Laid') totalEggsLaidCol = c;
  }

  // Parse check dates from header row 2
  const checkDates: string[] = [];
  const dateErrors: string[] = [];
  for (const ci of checkColIndices) {
    const iso = parseDate(header2[ci] ?? '');
    if (!iso) {
      dateErrors.push(`Column ${ci + 1}: unparseable date "${header2[ci]}"`);
    } else {
      checkDates.push(iso);
    }
  }

  if (dateErrors.length > 0) {
    return `Date parse errors:\n${dateErrors.join('\n')}`;
  }

  // Detect year
  const years = new Set(checkDates.map(d => parseInt(d.slice(0, 4), 10)));
  if (years.size > 1) {
    return `Dates span multiple years (${[...years].join(', ')}). A single import must contain only one year.`;
  }
  const year = [...years][0];

  // Detect import format
  type ImportFormat = 'a' | 'b' | 'c';
  let detectedFormat: ImportFormat = 'a';
  const col0Header = String(header1[0] ?? '').trim().toLowerCase();
  if (col0Header === 'housing unit') {
    detectedFormat = 'c';
  } else {
    const hasPipe = raw.slice(2).some(row => row && String(row[2] ?? '').includes('|'));
    if (hasPipe) detectedFormat = 'b';
  }

  // Track RA count per bare label to assign nesting_attempt
  const attemptCounter = new Map<string, number>();

  const rows: ImportRow[] = [];
  const errors: ImportError[] = [];

  for (let ri = 2; ri < raw.length; ri++) {
    const row = raw[ri];
    if (!row || row.every(c => !String(c).trim())) continue; // skip blank rows

    let housing_type: string, hole_type: string, rawLabel: string, ageStr: string, unit_name: string;

    if (detectedFormat === 'c') {
      unit_name    = String(row[0] ?? '').trim();
      housing_type = String(row[1] ?? '').trim().toUpperCase();
      hole_type    = String(row[2] ?? '').trim().toUpperCase();
      rawLabel     = String(row[3] ?? '').trim();
      ageStr       = String(row[4] ?? '').trim();
    } else if (detectedFormat === 'b') {
      housing_type = String(row[0] ?? '').trim().toUpperCase();
      hole_type    = String(row[1] ?? '').trim().toUpperCase();
      const combined = String(row[2] ?? '').trim();
      const pipeIdx  = combined.lastIndexOf('|');
      if (pipeIdx >= 0) {
        unit_name = combined.slice(0, pipeIdx).trim();
        rawLabel  = combined.slice(pipeIdx + 1).trim();
      } else {
        unit_name = defaultUnitName(housing_type);
        rawLabel  = combined;
      }
      ageStr = String(row[3] ?? '').trim();
    } else {
      housing_type = String(row[0] ?? '').trim().toUpperCase();
      hole_type    = String(row[1] ?? '').trim().toUpperCase();
      rawLabel     = String(row[2] ?? '').trim();
      ageStr       = String(row[3] ?? '').trim();
      unit_name    = defaultUnitName(housing_type);
    }

    if (!rawLabel) continue;

    const isRA = rawLabel.toUpperCase().endsWith(' (RA)');
    const bare = isRA ? rawLabel.slice(0, rawLabel.length - 5).trim() : rawLabel;

    // Assign nesting_attempt
    if (!isRA) {
      // First occurrence of this bare label sets attempt 1
      if (!attemptCounter.has(bare)) attemptCounter.set(bare, 1);
    } else {
      const cur = attemptCounter.get(bare) ?? 1;
      attemptCounter.set(bare, cur + 1);
    }
    const nesting_attempt = attemptCounter.get(bare) ?? 1;

    // Parse male/female age; normalize '?' → 'UNK'
    const normAge = (s: string | undefined): string | null => {
      const t = s?.trim();
      return !t ? null : t === '?' ? 'UNK' : t;
    };
    let male_age: string | null = null;
    let female_age: string | null = null;
    if (ageStr) {
      const parts = ageStr.split('/');
      male_age   = normAge(parts[0]);
      female_age = normAge(parts[1]);
    }

    // Parse check cells
    const checks: ImportRow['checks'] = [];
    for (let ci = 0; ci < checkColIndices.length; ci++) {
      const colIdx = checkColIndices[ci];
      const cellVal = String(row[colIdx] ?? '').trim();
      const date = checkDates[ci];

      if (!cellVal || cellVal.toUpperCase() === '') {
        // Blank = no entry for this check
        continue;
      }

      const result = parseCheckCode(cellVal);
      checks.push({ date, result });

      if (!result.ok) {
        errors.push({ row: ri + 1, date, raw: cellVal, reason: result.reason });
      }
    }

    const stated_eggs    = statedEggsCol    >= 0 ? parseIntCell(row[statedEggsCol])    : null;
    const stated_hatch   = statedHatchCol   >= 0 ? parseIntCell(row[statedHatchCol])   : null;
    const stated_fledge  = statedFledgeCol  >= 0 ? parseIntCell(row[statedFledgeCol])  : null;
    const total_eggs_laid = totalEggsLaidCol >= 0 ? parseIntCell(row[totalEggsLaidCol]) : null;

    rows.push({ rowIndex: ri + 1, unit_name, housing_type, hole_type, cavity_label: bare, nesting_attempt, male_age, female_age, checks, stated_eggs, stated_hatch, stated_fledge, total_eggs_laid });
  }

  return { year, check_dates: checkDates, rows, errors };
}

// ── Error export (highlighted correction sheet) ────────────────────────────────

export async function exportErrorSheet(
  uri: string,
  errors: ImportError[],
): Promise<string | null> {
  let base64: string;
  try {
    base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  } catch { return null; }

  let wb: any;
  try {
    wb = XLSX.read(base64, { type: 'base64' });
  } catch { return null; }

  const ws = wb.Sheets[wb.SheetNames[0]];
  const header1: string[] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })[0] as string[];

  // Build a map of (row, date) → col index
  const checkColIndices: number[] = [];
  for (let c = 0; c < header1.length; c++) {
    if (String(header1[c]).toLowerCase().includes('enter date of')) checkColIndices.push(c);
  }
  const header2: string[] = (XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as string[][])[1] ?? [];
  const dateToCol = new Map<string, number>();
  for (const ci of checkColIndices) {
    const iso = parseDate(header2[ci] ?? '');
    if (iso) dateToCol.set(iso, ci);
  }

  const errorFill = { patternType: 'solid', fgColor: { rgb: 'FF0000' } };
  const errorFont = { bold: true, color: { rgb: 'FFFFFF' }, name: 'Arial' };

  for (const err of errors) {
    if (!err.date) continue;
    const col = dateToCol.get(err.date);
    if (col == null) continue;
    const rowIdx = err.row - 1; // 0-based
    const addr = XLSX.utils.encode_cell({ c: col, r: rowIdx });
    if (ws[addr]) {
      ws[addr].s = { fill: errorFill, font: errorFont };
      ws[addr].v = `?? ${ws[addr].v}`;
    }
  }

  const outBase64 = XLSX.write(wb, { type: 'base64', bookType: 'biff8', cellStyles: true });
  const outPath = `${FileSystem.documentDirectory}PurpleSkies_import_errors.xls`;
  try {
    await FileSystem.writeAsStringAsync(outPath, outBase64, { encoding: FileSystem.EncodingType.Base64 });
    return outPath;
  } catch { return null; }
}
