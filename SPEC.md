# SPEC (ticket 4): browser menu to fetch OpenF1 sessions as Parquet

## Goal
A local web page with three dropdowns (year, event, session) and a **Fetch** button. Pressing Fetch downloads, from the free historical OpenF1 API (`https://api.openf1.org/v1`, no key), the data the proposal (`docs/VA_projectproposal_2088501.pdf`) needs for that one session, and stores it on disk (Parquet for time series, JSON for the rest). The menu shows what is already on disk by greying out what is not.

A browser cannot write to the repo, so a small Node server does the downloads and serves the page. The server is the "cache": a session counts as downloaded when its folder in `data/` passes a content check (below).

## Decisions
1. Plain JavaScript (ESM + JSDoc, no build step), as the ticket says. Type-checked with `tsc --noEmit` (`checkJs`).
2. A local web page served by a small Node server (dropdowns, greyed items and a button imply a browser; a browser cannot write to disk, so the server does the downloads). Terminal CLI and ticket 3's TypeScript design are dropped.
3. The earlier uncommitted ticket 3 SPEC is replaced by this file. The uncommitted deletion of `fast-f1/*` (Python loader) stays as is and is committed with this ticket's work.

## Menu behaviour
- **Year** dropdown: 2023 (first OpenF1 year) to current year, newest first.
- **Event** dropdown: only the meetings of the selected year (testing excluded), sorted by date, shown as `Round. meeting_name`. Changing the year reloads this list and resets event and session.
- **Session** dropdown: only the sessions of the selected event. Changing the event reloads it and resets the session.
- Only sessions with a known name (table below) that have started (`date_start <= now`) and are not cancelled are listed. Events with none are not listed. Years with none are not listed.
- **Greyed out** = not fully downloaded. Still selectable (the user must be able to pick it to fetch it).
  - Session: grey unless it passes the content check.
  - Event: grey unless **all** its listed sessions are on disk.
  - Year: grey unless **all** events of that year are not grey.
  - This is computed by the server from disk on every catalog request, so it updates after a fetch finishes without a page reload (the page re-requests the catalog when a job ends).
- **Fetch** button: enabled only when a session is selected and it is not currently being fetched. Click starts the download for that session only. Shows progress ("car_data driver 1 (12/20): N rows") and a final success or error message. Fetching an already downloaded session is allowed and replaces it (the button reads "Fetch" in both cases, per the ticket).
- Nothing is fetched on selection; only the button starts a download.

## What is downloaded per session
Derived from the proposal's needs:

| Proposal need | OpenF1 endpoint | Output |
|---|---|---|
| Event/session identity, session start | `meetings`, `sessions` | `session.json` (taken from the catalog responses, cached 1 h for the current year and indefinitely for past years; not refetched on Fetch) |
| Driver names, teams, numbers | `drivers` | `drivers.json` |
| Throttle, RPM, brake/DRS, gear, speed over time | `car_data` (per driver) | `car_data.parquet` |
| Track outline and moving dots | `location` (per driver) | `location.parquet` |
| Lap times, sector split times | `laps` | `laps.parquet` |
| Tyre compound, tyre age, stints | `stints` | `stints.json` |
| Pit-in / pit-out times | `pit` | `pit.json` |
| Weather | `weather` | `weather.json` |
| Track state, safety car | `race_control` | `race_control.json` |
| Top-10 / points scorers | `session_result` | `session_result.json` |

Excluded for now (not in the proposal; one table row each in `endpoints.js` if wanted later): `intervals`, `position`, `team_radio`, `overtakes`, `starting_grid`, `championship_*`. 

Rules (see Shared rules): dump only, every API field kept, `meeting_key`/`session_key` moved to `session.json`, extra Int32 column `t` = ms since `session.date_start`, narrowest Parquet types, every column nullable, one row group, rows sorted by driver then `t`, empty endpoint still gets a file, 404 "No results found." is zero rows, list columns kept (`laps.segments_sector_*`), per-driver requests for `car_data` and `location` (driver list = `drivers` ∪ drivers seen in `laps`).

## Shared rules (fetching, format)
- **Pacing:** sequential requests, at least 350 ms apart.
- **Empty results:** HTTP 404 with `detail` "No results found." becomes `[]` (and is cached); any other 404 is an error.
- **Retries:** on 429, 5xx or network error, up to 5 retries, exponential backoff from 1 s, `Retry-After` honoured.
- **Disk cache:** every successful response stored as `loader/cache/<sha1 of URL>.json`. Used for the year catalog (`meetings`, `sessions`; 1 h for the current year, forever for past years). A Fetch click bypasses the cache for the session's data, so a retry never replays an earlier empty or partial answer.
- **Timestamps** are ISO 8601 UTC (`2025-05-18T13:30:00.037000+00:00` or `...+00:00` without fraction).
- **Content:** every field the API returned is kept with API names and values, except `meeting_key`/`session_key` (constant per session, kept in `session.json`). Nested arrays (`laps.segments_sector_1..3`) stay as JSON arrays / Parquet list columns.
- **Column `t`:** every row with a timestamp (`date`, or `date_start` on `laps`) gets `t`, Int32 ms since `session.date_start` (negative before start). Parquet files store the timestamp only as `t`; JSON files keep the ISO string too.
- **Parquet:** one file per endpoint, one row group, rows sorted by `driver_number` then `t`, every column nullable, SNAPPY if `hyparquet-writer` supports it else none (recorded in `session.json`). Types: `driver_number` u8; `rpm`, `speed`, `lap_number` i16; `n_gear`, `throttle`, `brake`, `drs` i8; `x`, `y`, `z`, `t` i32; decimals (lap/sector durations) f64; speed traps (`i1_speed`, `i2_speed`, `st_speed`) i16 (the API gives integers; a non-integer value widens the column to f64); other fields by value.
- **Every endpoint gets a file**, even with 0 rows (empty array, or schema-only Parquet).
- **Session abbreviations:** Practice 1/2/3 = FP1/FP2/FP3, Qualifying = Q, Sprint Qualifying = SQ, Sprint Shootout = SS, Sprint = S, Race = R.
- **Folder:** `data/<year>/<round:02d>-<meeting slug>/<abbr>/`, round = 1-based index of the year's non-testing meetings by `date_start`, slug = lowercase name with non-alphanumerics as `-` (e.g. `data/2025/07-emilia-romagna-grand-prix/R/`). Written to `<folder>.tmp`, renamed at the end; a failed fetch leaves nothing. Re-fetching replaces the folder.
- **`session.json`:** `schema_version: 1`, `generated_at`, `source: "openf1"`, `meeting`, `session` (raw API objects), `round`, `abbreviation`, `date_start_ms`, `parquet_compression`, `files` (`{name: row_count}`).

## Output layout
See Shared rules. **Content check** (`verifySession`): `session.json` parses with `schema_version` 1, and every file in its `files` map exists and its row count matches (JSON: array length; Parquet: footer row count via `hyparquet`), and no extra expected endpoint file is missing. Anything else (missing, truncated, corrupt, stale `.tmp`) means not downloaded. `/data/` is gitignored.

## Server API (`loader/src/server.js`, Node `http`, no framework, binds 127.0.0.1)
- `GET /` and static files from `loader/public/`.
- `GET /api/catalog` returns `[{year, cached, events:[{meeting_key, round, name, cached, sessions:[{session_key, name, abbr, cached}]}]}]`. Built from `meetings?year=Y` and `sessions?year=Y` for each year, cached on disk in `loader/cache/` (permanent for past years, 1 h for the current year), plus a scan of `data/`.
- `POST /api/fetch` body `{session_key}`: starts a job, returns `{jobId}`. 409 if that session is already running; 400 if the session is not in the catalog (unknown, future or cancelled). One job at a time overall (OpenF1 pacing): a second request while busy gets 409.
- `GET /api/jobs/:id` returns `{state: running|done|error, progress, error?}`; the page polls it every 500 ms.

The "no data yet" case (laps and all car_data empty) is an error and leaves nothing on disk.

## Files
New:
- `loader/package.json` (ESM, scripts `start`, `test`, `lint`; `engines.node >= 22`), deps `hyparquet-writer`, `hyparquet` (tests + post-write check); dev `eslint`, `@eslint/js`, `typescript` + `// @ts-check` with `tsc --noEmit` and `checkJs` for type checking.
- `loader/src/server.js`, `catalog.js` (pure: build tree, cached flags), `api.js` (fetch wrapper), `endpoints.js`, `write.js`, `download.js` (one session).
- `loader/public/index.html`, `menu.js` (DOM), `menu-state.js` (pure: filtering and grey state), `menu.css`.
- `loader/test/*.test.js`, fixtures in `loader/test/fixtures/` (small trimmed real responses).
- `.gitignore`: add `loader/cache/`, `/data/`; drop the Python lines.

## Running
```sh
cd loader && npm install && npm start      # http://127.0.0.1:3000
```

## How we know it works
`npm test`, `npm run typecheck`, `npm run lint` pass in `loader/`. Unit tests:
- **Grey logic:** session cached only when the content check passes (truncated Parquet, wrong row count, missing file, corrupt JSON all fail); event cached only if all sessions are; year only if all events are; partial cases stay grey; unstarted/cancelled/testing excluded; year and event filtering of the lists.
- **Fetch wrapper:** 404 empty gives `[]` and is cached; other 404 throws; 429 retry with `Retry-After`; 350 ms spacing; cache hit does no request.
- **Writers:** Parquet round trip per fixture (values, nulls, list columns, ); empty endpoint writes schema-only file; `t` correct incl. negative; JSON rows equal input minus keys plus `t`.
- **Server:** with mocked OpenF1, `/api/catalog` flags flip after a fetch job completes; double-fetch gives 409; unknown session gives 400; failed job leaves no folder.

Live check, recorded here when done: start the server; open the page with a headless browser or `curl` on the API; Fetch 2025 Imola Race; confirm the files exist, the Parquet files read back with `hyparquet` (VER about 33k `car_data` rows), session/event/year flags become un-grey as sessions complete (check the event flag by fetching all its sessions on a sprint-less weekend, or by seeding fixture folders), and a second page load shows the same state.

## Resolved questions
1. The 10-endpoint subset is accepted for now.
2. This ticket's commit includes the `fast-f1/*` deletions.
3. "Downloaded" means the content check passes, not just that a file exists.

## Live check results (done)
- Server started on 127.0.0.1; `/api/catalog` returned 2026-2023 (19/24/24/22 events) in 2.5 s.
- Fetch 2025 Emilia Romagna GP Race: 55 requests, all 9 endpoint files plus `session.json`; sizes: `car_data.parquet` 4.4 MB (662,460 rows), `location.parquet` 4.9 MB (679,580 rows), `laps.parquet` 45 KB (1,207 rows), JSON files under 30 KB each.
- Read back with `hyparquet` (Node): `car_data` 662,460 rows in 0.87 s; VER 33,123 `car_data`, 33,979 `location`, 63 laps; 20 drivers.
- Catalog after the fetch: only `R` un-grey; event and all years stay grey (other sessions missing). Event/year flip is covered by the server test that fetches every session of the mocked year.
- Headless Chromium `--dump-dom` of the page: the year dropdown is populated from the catalog with all years greyed (`class="grey"`). Clicking through the dropdowns and the Fetch button in a browser was not automated; that DOM logic is covered only by the pure `menu-state` tests.
- Second load: after restarting the server and loading the page in headless Chromium, `/api/catalog` still shows Imola `R` un-grey and FP1/FP2/FP3/Q grey (state comes from disk).
- Fixtures in `loader/test/fixtures/` are trimmed real Imola 2025 Race rows (`car_data`, `location`, `laps`) and are round-tripped through Parquet in `write.test.js`.

---

# Ticket 5: grey state visible inside the open dropdown

## Pre-existing failures
none (`npm test` 32 pass, `typecheck` and `lint` clean).

## Problem
The grey state is only CSS `color` on `<option class="grey">`. Browsers/OSes that render the native popup ignore option styling, so in the open list every item is black on white and downloaded vs. not cannot be told apart. Only the closed select (which has `select.grey`) shows it.

## Change
Make the state part of the option **text**, which every popup renders, and keep the colour as extra hint.
- `loader/public/menu-state.js`: new pure `optionText(o)` returning `"● " + label` when downloaded and `"○ " + label` when grey (matched glyph pair from one family, so labels stay aligned). Placeholder unchanged.
- `loader/public/menu.js` `fill`: use `optionText(o)` for the option text.
- `loader/public/menu.css`: give `option` an explicit `background: Canvas; color: CanvasText` and keep `option.grey { color: #999 }`, so browsers that do honour option styling also show it reliably.
- `loader/public/index.html`: short legend under the dropdowns: "● downloaded, ○ not (fully) downloaded".
- `loader/test/menu-state.test.js`: test `optionText` for both states. `label` values stay unchanged, so existing tests are untouched.

## How we know it works
`npm test`, `npm run typecheck`, `npm run lint` pass. Open dropdowns can't be screenshotted by headless Chromium (native popup), so the visible text marker is verified by the unit test plus a headless `--dump-dom` showing the `●`/`○` prefixes in the option text.

---

# Ticket 6: partial marker for partly downloaded years/events

## Pre-existing failures
none (`npm test` 33 pass, `typecheck` and `lint` clean).

## Problem
Years and events show only `●` (fully downloaded) or `○` (not fully downloaded). An event with some sessions on disk looks the same as one with none.

## Change
Add a third state, **partial**, shown with `◐` (U+25D0, same Geometric Shapes family as `●`/`○`, so labels stay aligned).
- **Event** is partial when it is not fully downloaded but at least one of its sessions is.
- **Year** is partial when it is not fully downloaded but at least one session of any of its events is.
- **Session** stays two-state (a session is downloaded as a whole or not at all).
- Partial items keep the grey colour (they are still not fully downloaded); only the marker differs.

Computed client-side from the existing catalog (session `cached` flags are already sent), so the server API and `catalog.js` are unchanged.

Files:
- `loader/public/menu-state.js`: `yearOptions`/`eventOptions` add `partial: boolean` to each option (sessionOptions sets `partial: false`); `optionText` returns `◐ label` when `partial`, else `●`/`○` as before.
- `loader/public/menu.js`: no change needed (`fill` already uses `optionText`; grey class unchanged). Will touch only if typing requires.
- `loader/public/index.html`: legend becomes "● downloaded, ◐ partly downloaded, ○ not downloaded".
- `loader/test/menu-state.test.js`: tests for partial on years and events (none / some / all sessions cached), and `optionText` for the partial marker.

## How we know it works
`npm test`, `npm run typecheck`, `npm run lint` pass in `loader/`. New unit tests cover: event with some sessions cached → partial; with none → not partial, grey; with all → not partial, not grey; year partial when any event has any cached session, not partial when fully cached or nothing cached. Headless `--dump-dom` against the live data (Imola 2025 R is on disk) shows `◐` on 2025 and on the Emilia Romagna event.

## Live check results (done)
- `npm test` 35 pass; typecheck and lint clean.
- Headless Chromium `--dump-dom` against live data (only 2025 Imola R on disk): year options `○ 2026`, `◐ 2025`, `○ 2024`, `○ 2023`. Event options for 2025 (via `eventOptions` on the live `/api/catalog`): only `◐ 7. Emilia Romagna Grand Prix` is not `○`.
