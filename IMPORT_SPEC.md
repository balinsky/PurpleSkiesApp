# Purple Skies Import Data Specification

This document defines the rules for importing historical nest check data into Purple Skies via XLS, XLSX, or CSV file. It also governs what the app's XLS export must produce so that exports are directly re-importable.

---

## File Layout

The file must follow the Purple Skies two-header-row layout:

| Row | Content |
|-----|---------|
| 1 (header) | Column labels. Check columns contain text like "Enter date of 1st nest check here:" |
| 2 (sub-header) | Check date columns contain the actual date in **M/D/YYYY** format |
| 3+ (data) | One row per compartment per nesting attempt |

For CSV exports, the info/legend block to the right of the data (site contact info, code legends, banding summary) is present but ignored during import.

---

## Static Columns (A–I)

| Col | Field | Rules |
|-----|-------|-------|
| A | Housing Type | One of: `WH` `MH` `PH` `NG` `AG`. Case-insensitive. |
| B | Hole Type | One of: `RH` `CH` `EH` `OH`. Case-insensitive. Optional; blank is accepted. |
| C | Cavity label | Plain label (e.g. `A1`, `P`). Append ` (RA)` for renesting attempts (see below). |
| D | Male/Female Age | Optional age pair (e.g. `ASY/SY/UNK`). Stored in `nest_seasons`. |
| E–I | Computed fields | Ignored on import (first egg date, total eggs, projected hatch date, actual hatch date, fledge date). |

### Housing Type Codes
| Code | Type |
|------|---------|
| `WH` | Wooden House |
| `MH` | Metal House |
| `PH` | Plastic House |
| `NG` | Natural Gourd  |
| `AG` | Artificial Gourd |

### Hole Type Codes
| Code | Type |
|------|---------|
| `RH` | Round Hole |
| `CH` | Crescent Hole |
| `EH` | Excluder Hole |
| `OH` | Obround Hole |

### Adult Age Codes
| Code | Type |
|------|---------|
| `ASY` | After Second Year (e.g. hatched earlier than last year) |
| `SY` | Second Year (e.g. hatched last year) |
| `UNK` | Unknown |

### Date Formats
Dates should be MM/DD/YYYY with leading zeroes optional. (e.g. 5/1/1998, 5/17/2020)


### Renesting attempts

Append ` (RA)` to the cavity label for each renesting attempt row. If a cavity has multiple RA rows, they are numbered sequentially (2, 3, 4…) in top-to-bottom order in the file.

| Cavity column value | `nesting_attempt` |
|--------------------|-------------------|
| `P` | 1 |
| `P (RA)` | 2 |
| `P (RA)` (second row) | 3 |

---

## Check Code Columns

Columns 10 through N−3 (the columns between the static block and the final Egg/Hatch/Fledge summary) are check columns. Each cell contains a **check code** or is blank.

**Blank cell** = no entry recorded for that check (no `nest_check_entry` row is created).

---

## Check Code Format

### General structure

```
[SPECIES] CONTENT [SUFFIX …]
```

- The species prefix and the content code may be separated by a space or not: `HS ND` and `HSND` are equivalent.
- Multiple suffixes are space-separated.
- Codes are **case-insensitive** on import; the export produces uppercase.

### Species codes

| Code | Species |
|------|---------|
| *(omitted)* | Purple Martin (implied) |
| `PM` | Purple Martin (explicit) |
| `HS` | House Sparrow |
| `ST` | Starling |
| `TS` | Tree Swallow |
| `BB` | Bluebird |
| `HW` | House Wren |

### Content codes

#### Purple Martin

| Code | Meaning | DB fields set |
|------|---------|---------------|
| `X` | Empty cavity | `species=null` |
| `N` or `PMN` | PM nest, no eggs | `species=PM`, `has_nest=true`, `egg_count=0` |
| `{n}E` | n eggs found (none discarded) | `species=PM`, `egg_count=n` |
| `{n}ED` | n eggs found, all discarded | `species=PM`, `egg_count=n`, `discarded_eggs=n` |
| `{n}E {m}ED` | n total eggs found, m of which were discarded | `species=PM`, `egg_count=n`, `discarded_eggs=m` |
| `{n}Y` | n live young (age unknown) | `species=PM`, `young_count=n` |
| `{n}Y HD` | n young, hatch day | `species=PM`, `young_count=n`, `nestling_age_days=0` |
| `{n}Y {d}do` | n young, d days old | `species=PM`, `young_count=n`, `nestling_age_days=d` |
| `ND` | Nest discarded | `species=PM`, `nest_discarded=true` |
| `{n}DY` | n dead young (always removed) | `dead_young_count=n` |
| `DADM` | Dead adult male discarded | `dead_adult_sex='M'` |
| `DADF` | Dead adult female discarded | `dead_adult_sex='F'` |
| `DAD` | Dead adult discarded, sex unknown | `dead_adult_sex='U'`; flagged as a warning on import |

> **Legacy note:** The bare code `D` (used in older Purple Skies exports for PM nest discarded) is accepted on import and treated identically to `ND`. New exports must use `ND`.
> **DY note:** `DYD` is accepted as an alias for `DY` on import. Dead young are always removed; the D suffix is redundant. New exports always use `DY`.

#### Non-PM species

| Code | Meaning |
|------|---------|
| `{SP}N` or `{SP} N` | Species present, nest only |
| `{SP} {n}E` | Species present, n eggs |
| `{SP} {n}Y` | Species present, n young |
| `{SP} {n}E {m}Y` | Species present, n eggs and m young |
| `{SP}ND` or `{SP} ND` | Nest discarded |
| `{SP} {n}E {m}ED` | n total eggs found, m discarded |
| `{n}DY` | n dead young (any species) |
| `DADM` / `DADF` / `DAD` | Dead adult (any species); same rules as PM |

Hatch/fledge prediction is not performed for non-PM species.

### Suffix modifiers

Suffixes follow the content code, separated by a space.

| Suffix | Meaning | Import behavior |
|--------|---------|-----------------|
| `B` | Banding recorded | Noted but banding detail not imported (enter manually) |
| `GR` | Gourd removed | `gourd_removed=true` |
| `RA` | *(cavity label column only)* | See Renesting section above |

---

## Age Codes (column D)

Format: `{MALE}/{FEMALE}` where each component is one of:

| Code | Meaning |
|------|---------|
| `ASY` | After Second Year (adult) |
| `SY` | Second Year (subadult) |
| `UNK` | Unknown |

Either component may be blank (e.g. `ASY/` means male=ASY, female unknown). A blank cell means no age recorded.

---

## Year and Season Detection

- The import reads all dates from the check-date sub-header row (row 2).
- If all dates fall within the same calendar year, that year is used automatically.
- If dates are missing or ambiguous, the user is asked to specify the year.
- Seasons never cross calendar year boundaries; a file with dates in more than one year is an error.

---

## Housing Creation

If a `housing_unit` with the given name does not yet exist for the target site season, it is created. If a `compartment` with the given label does not exist within that unit, it is created using the Housing Type and Hole Type from the file.

---

## Error Handling

The import is staged (parsed and validated) before any data is written to the database.

### Error categories

| Category | Example | Behavior |
|----------|---------|----------|
| Unrecognised code | `FOO` | Cell highlighted; user must correct or skip |
| Ambiguous count | `3D` (missing E or N) | Cell highlighted; user must correct |
| Unknown species | `ZZ 2E` | Cell highlighted |
| Unparseable date | `13/45/2024` | Entire column rejected; user must correct |
| Multi-year dates | Dates in 2023 and 2024 | Import rejected; user must split the file |

### Correction workflow

1. The app presents a staging summary: year detected, compartment count, check count, error list.
2. If errors exist, the user may download a **corrected sheet** — the original file with erroneous cells highlighted in red (or prefixed with `??` in CSV) and a note in an adjacent column.
3. The user corrects the download and re-imports.
4. Alternatively, the user may choose **Import without errors** (skip errored rows) or **Cancel**.

---

## Conflict Handling

If a `site_season` for the detected year already exists at the selected site, the user is asked to choose:
- **Merge** — import only checks and entries that do not already exist; do not overwrite.
- **Cancel** — abort the import.

---

## Summary Columns (last 3)

The final three columns (Egg #, Hatch #, Fledge #) are computed summaries and are **ignored on import**.
