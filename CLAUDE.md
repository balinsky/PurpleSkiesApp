# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Expo versioning

**Expo has changed significantly.** Always read the exact versioned docs at https://docs.expo.dev/versions/v56.0.0/ before writing any code that touches Expo APIs. The current SDK version is **56**.

## Commands

```bash
# Development
expo start               # Start dev server (Metro bundler)
expo run:ios             # Build and run on iOS simulator
expo run:android         # Build and run on Android emulator

# Tests
npm test                 # Run Jest unit tests (tests in __tests__/*.test.ts)

# iOS distribution
bundle exec fastlane ios beta    # Build + upload to TestFlight (increments build #)
bundle exec fastlane ios build   # Build only (no upload)
bundle exec fastlane ios upload  # Upload existing .ipa without rebuilding
```

## Architecture

**Purple Skies** is an offline-first Purple Martin nest monitoring app for iOS/Android.

### Data flow

Local SQLite (expo-sqlite) is the primary store. All writes go to SQLite first with `sync_status = 'pending'`, then `lib/sync.ts` pushes them to Supabase in dependency order. Supabase is the source of truth for reads on screens that load data — screens call Supabase directly, not SQLite.

### Data model hierarchy

```
sites (Supabase only)
  └── site_seasons (Supabase only, one per year)
        ├── housing_units  (has site_season_id FK; legacy housing has site_season_id = NULL)
        │     └── compartments  (same site_season_id FK as parent unit)
        └── nest_checks  (date + creator)
              └── nest_check_entries  (one per compartment; eggs, nestlings, banding data)
                    ├── nestlings
                    └── bands
```

### Season-scoped housing

Housing is tied to a `site_season_id`. Legacy housing (created before per-season support) has `site_season_id = NULL`. When loading housing for a season, the app falls back to legacy housing if no season-specific housing is found. If a user "copies" legacy housing to a season, new UUIDs are created for housing_units and compartments — existing nest_check_entries that reference the old UUIDs will break.

### Key files

| File | Purpose |
|---|---|
| `lib/localDb.ts` | SQLite schema, migrations, CRUD helpers, `makeId()` UUID generator |
| `lib/sync.ts` | Pushes `pending` records to Supabase; `getPendingCount()` for UI badge |
| `lib/nestLogic.ts` | Business logic for nest check calculations |
| `lib/exportXls.ts` | Excel export using `xlsx-js-style`; `has_banding` is computed (not a DB column) |
| `contexts/SyncContext.tsx` | Network state, pending count, manual sync trigger |
| `contexts/SettingsContext.tsx` | `BandingEnabled`, compact mode, calendar view — persisted to AsyncStorage |
| `App.tsx` | Navigation setup, auth state, provider hierarchy |

### Navigation

Type-safe stack navigation via `AppStackParamList` in `App.tsx`. Provider hierarchy (outermost first): `SafeAreaProvider → PaperProvider → SettingsProvider → SyncProvider → NavigationContainer`.

## Coding conventions

- **State variables**: PascalCase (`const [NestChecks, setNestChecks]`)
- **Compartment sort**: always use `localeCompare` with `{ numeric: true, sensitivity: 'base' }` for natural sort of labels like A1, A2, A10
- **Supabase selects**: only include columns that actually exist in the DB schema. Unknown columns cause silent null returns, not errors.
- The `has_banding` field is **not** a database column — it is computed in `exportXls.ts` from the `bands` table.

## iOS native icon

The native iOS icon at `ios/PurpleSkiesApp/Images.xcassets/AppIcon.appiconset/App-Icon-1024x1024@1x.png` is gitignored. When `assets/icon.png` is updated, manually copy it there:

```bash
cp assets/icon.png ios/PurpleSkiesApp/Images.xcassets/AppIcon.appiconset/App-Icon-1024x1024@1x.png
```

Apple rejects icons with an alpha channel (error 90717). Strip alpha before building:

```bash
magick assets/icon.png -background white -alpha remove -alpha off assets/icon.png
```

## Banding

Banding data entry is gated behind `BandingEnabled` in `SettingsContext`. It requires a federal USFWS bird banding permit (Migratory Bird Treaty Act, 50 CFR 21.70) plus state/province permits, and the UI includes a legal notice. Banding fields appear in `NestCheckEntryScreen` and banding columns appear in the XLS export only when `BandingEnabled` is true.

## Testing

Tests live in `__tests__/` and use Jest with `ts-jest`. Mocks for `expo-sqlite` and `react-native` are in `__mocks__/`. The test DB uses `better-sqlite3` (synchronous API, no Expo runtime needed).
