# GarvStoreDash — Scoring & Metrics Methodology

Reverse-engineered from source. All line references are to
[`public/index.html`](public/index.html) unless noted otherwise. The server-side
copy of the pipeline in
[`netlify/functions/store-ingest.mjs`](netlify/functions/store-ingest.mjs) is a
verbatim port of the same functions (its own header comment says so) and is used
by the automated Gmail/VinSolutions ingestion bot.

---

## 0. Headline finding: there is no composite score

The dashboard deliberately has **no weighted score, no index, no grade, and no
lead minimum**. The section header in the source is literally
`RAW SCORING — no lead minimum, no composite weights` ([index.html:575](public/index.html:575)),
the table footer prints *"No lead minimum applied"*, and the AI system prompt
states *"Metrics: raw counts, no composite score"* ([index.html:1351](public/index.html:1351)).

Everything the UI calls a "score" is one of three things:

1. **A raw count** (leads, visits, write-ups, deliveries).
2. **A simple ratio** of two of those counts (Cov%, Vis%, WU%).
3. **A tier label** derived from a single median (Speed Tier — computed but *not
   rendered* anywhere; see §9).

The `s-score` element in the store rail is not a score at all — it is
`liveStores/totalStores` for the Network tab and `Nmo` (period count) or the
state abbreviation for each store tab ([index.html:916–939](public/index.html:916)).

Everything below therefore documents **how each metric is derived**, which is
what "how each score is calculated" reduces to in this codebase.

---

## 1. Input

A **VinSolutions master lead export** CSV. The file is accepted only if the
header row contains all four of `Sales Rep`, `Visit Result`, `Write Up`,
`Contacted Indicator` (`looksLikeMasterCSV`, [index.html:484](public/index.html:484)).

Columns actually consumed (`parseMasterCSVv2`, [index.html:458](public/index.html:458)):

| Purpose | CSV header |
|---|---|
| Rep attribution | `Sales Rep` |
| Lead routing / filtering | `Lead Source`, `Lead Source Group`, `Lead Type`, `Make` |
| Lead quality | `Lead Status`, `Lead Status Custom`, `Lead Status Type` |
| Timing | `Lead Origination Date`, `Lead Last Modified Date`, `Visit Start Date` |
| Response speed | `Adjusted Response Time (Min)`, `Last Attempted Phone Contact`, `Last Attempted Email Contact`, `Last Attempted Text Contact Datetime` |
| Contact flag | `Contacted Indicator` |
| Showroom | `Showroom Visit ID`, `Visit Result`, `Write Up`, `Trade Appraisal`, `Assigned User - User Group` |
| Dedup identity | `Customer`, `Email`, `Daytime Phone`, `Evening Phone`, `Cell Phone`, `Stock Number` |

Duplicate header names are disambiguated by appending `_2`; a UTF-8 BOM is
stripped from cell `[0][0]`. Rows with `length <= 1` are dropped.

### Period assignment

The month a file belongs to is parsed **from the filename**, never from the data.

Browser and server now run one **canonical, byte-identical** parser
(`periodFromFileName` in [index.html](public/index.html) and
[store-ingest.mjs](netlify/functions/store-ingest.mjs)). Accepted forms, tried in
order:

| # | Pattern | Example | → |
|---|---|---|---|
| 1 | `<store>_<dd>_<mm>_<yy>.csv` | `hammond_15_03_26.csv` | `2026-03` |
| 2 | `<store>_<monthname\|abbr>_<yy>.csv` | `breaux_bridge_june_26.csv` | `2026-06` |
| 3 | same, with trailing suffix tokens (right-to-left scan) | `hammond_june_26_v2.csv` | `2026-06` |

Format 1 is **day-first**: the *second* number is the month. A month outside
1–12 is rejected rather than producing a nonsense period.

Store ID is sniffed from the filename prefix in the browser
([index.html:1392](public/index.html:1392)) but is an explicit parameter
server-side — that difference is intentional and remains.

If no period can be parsed in the browser, the upload is filed under a synthetic
`upload-<timestamp>` period labelled with the raw filename.

---

## 2. Row filtering (who is even eligible)

`recomputeRaw` step 1 ([index.html:579–589](public/index.html:579)). A row must survive **all** of:

**a. 700 Credit exclusion**
- Normal store tabs: drop if `Lead Source === '700credithmd'` or `Lead Source Group === '700 Credit'` (exact match).
- Airstream tab: drop if either field *contains* `"700"` (case-insensitive) — a broader test.

**b. Airstream routing** (`isAirstreamLead`, [index.html:420](public/index.html:420))
A lead is "Airstream" if any of:
- `Lead Source` contains `airstream` or `aimbase`, **or**
- `Lead Source Group` contains `airstream`, **or**
- `Make` contains `airstream`.

Then:
- On the **Airstream** tab: keep only Airstream leads, and additionally drop any
  where `Lead Status Custom === 'bad'` or `Lead Status Type === 'bad'`
  (`isAirstreamBadStatus`, [index.html:429](public/index.html:429)).
- On **every other** tab: drop all Airstream leads.

> The Airstream `'bad'` exclusion has no equivalent on the store tabs — Airstream
> leads are filtered on two status columns that store tabs never look at.

**c. Rep must be tracked** (`isTrackedRep`, [index.html:452](public/index.html:452))
- Non-empty `Sales Rep`, **and**
- Not in the 20-name hard-coded `BLACKLIST` ([index.html:441](public/index.html:441)) — matched on
  a normalised name (trim → collapse whitespace → lowercase), **and**
- Not a system account: name contains `your friends at great american rv` or
  `yod house agent` ([index.html:451](public/index.html:451)).

> `isTrackedRep(storeId, name)` accepts a `storeId` and never uses it — the
> blacklist is global across all 10 stores, so a name blacklisted for one
> rooftop is blacklisted everywhere.

The surviving set is called `filtered`. Visit statistics are computed from
`filtered` — i.e. before customer deduplication — which is harmless now that
visits are keyed on `Showroom Visit ID` (§5).

---

## 3. Customer deduplication

`dedupCustomers` ([index.html:493](public/index.html:493)) — a union-find (disjoint-set) merge over
`filtered`.

Two rows are unioned if they share **any** of:
- normalised customer name (`trim → lowercase → collapse whitespace`),
- normalised email (must contain `@`),
- any normalised phone from `Daytime`/`Evening`/`Cell` (digits only; leading US
  `1` stripped; must be exactly 10 digits).

Merging is **transitive**: A shares a phone with B, B shares an email with C →
A, B, C are one customer.

> ⚠️ A shared household or business phone number will silently merge two genuinely
> different customers, collapsing their leads into one.

**Survivor selection per cluster** ([index.html:511–516](public/index.html:511)):
prefer a **Sold** row over a non-sold one; among equals, prefer the **latest
`Lead Origination Date`**. That survivor becomes the cluster's single lead.

**Extra deliveries** ([index.html:521–531](public/index.html:521)):
any *other* row in the cluster that is Sold **and** has a `Stock Number` not
already seen in the cluster is pushed onto an `extraSales` list. This is how a
repeat buyer who purchased two different units in the same month still counts as
two deliveries while counting as one lead. `extraSales` rows carry
`inLeadPeriod = false` by construction — they only ever add to deliveries, never
to the lead denominator.

---

## 4. Date-range classification

Applied only when a date filter is active; otherwise `noFilter = true` and every
row is in-period.

```
fromMs = new Date(fromStr + 'T00:00:00.000')   // local midnight
toMs   = new Date(toStr   + 'T23:59:59.999')   // local end-of-day
```

The explicit local time strings are deliberate — the source comment at
[index.html:591](public/index.html:591) documents that date-only strings parse as
UTC midnight and would otherwise drop the last day of a range in US timezones.

Each deduped lead gets ([index.html:621–626](public/index.html:621)):

| Flag | Rule |
|---|---|
| `sold` | `Lead Status Type === 'Sold'` (exact, trimmed) **OR** `isPendingSold()` — see §6a |
| `inLeadPeriod` | `Lead Origination Date` inside `[from, to]`. An **unparseable** origination date counts as in-period. |
| `inSalePeriod` | `sold` **and** the sale date is inside `[from, to]` |

**Sale date** = `Lead Last Modified Date`, falling back to
`Lead Origination Date` when the former is unparseable. The Summary KPI strip
labels the Deliveries tile *"per Lead Last Modified Date"*.

A lead is kept if `inLeadPeriod || inSalePeriod`.

### Date-range presets

Presets are anchored to an **"as-of" date** (`periodAsOfDate`, [index.html:831](public/index.html:831)),
not to real-world today — unless you are viewing the actual current calendar
month. For a historical period the anchor is that period's **last observed
`Lead Origination Date`** (`_rawDates`), falling back to the calendar last day of
the month. This prevents "MTD" on a March snapshot from meaning "March 1 →
today".

| Preset | From | To |
|---|---|---|
| All Data | — | — |
| MTD | first of as-of month | as-of |
| Last 30 | as-of − 30 days | as-of |
| Last 7 | as-of − 7 days | as-of |
| Custom | user `from` | user `to` |

Date filtering requires the **row-level blob** for that period. If it is absent
the UI refuses to render a filtered label over unfiltered numbers — it shows a
loading state, then a "Date filtering isn't available for this period" banner
([index.html:1031–1052](public/index.html:1031)).

---

## 5. Showroom visit statistics

Computed independently of the lead pipeline, from `filtered`
([index.html:604–616](public/index.html:604)). A row counts as a visit if **all** hold:

1. `Showroom Visit ID` is non-empty,
2. `Visit Result !== 'Deleted'`,
3. `Assigned User - User Group` is **not** one of `Manager`, `Reception`, `Admin`,
4. `Sales Rep` is non-empty,
5. when a date filter is active, `Visit Start Date` falls inside the range.

Qualifying rows are then **collapsed to one entry per `Showroom Visit ID`**
before tallying:

- **Rep attribution:** first row seen for that visit ID wins.
- **`Write Up` / `Trade Appraisal`:** OR-ed across every row belonging to the
  visit, so a `Y` on any single row counts exactly once.

Then per rep: `visits++`; `write_ups++` if the visit's write-up flag is set;
`trades++` if its trade flag is set.

> **Previously:** the tally ran per *row*, and `Showroom Visit ID` was only
> tested for presence, never used as a key, so one visit spread across several of
> a customer's lead rows would be counted once per row.
>
> **Measured impact: none on real data.** A real 338-row export carried 175 rows
> with a visit ID and 175 *distinct* visit IDs — VinSolutions emits one row per
> visit in this report. This fix is a **safety net against a case the export does
> not currently produce**, not a correction to existing numbers. Earlier drafts of
> this document overstated it as a systematic distortion; that was measured on a
> synthetic fixture, not real data.
>
> ⚠️ **If a future export ever does repeat a visit ID**, stored snapshots from
> before this fix would carry the old per-row tally. Until such a period is
> re-uploaded, its stored "All Data" snapshot would disagree with any
> date-filtered view of that same period is recomputed client-side with the new
> logic — so the two will disagree. Re-uploading (or re-running the ingest bot
> for) each period rewrites the snapshot and removes the discrepancy.

---

## 6. Per-rep metric definitions

Computed at [index.html:640–665](public/index.html:640). Reps are re-checked against the blacklist
and system-account patterns here as a second gate.

Let, for one rep:
- **L** = leads with `inLeadPeriod`
- **V** = subset of L whose `Lead Status` is **not** in `BAD_STATUSES`
- **D** = leads (including injected `extraSales`) with `inSalePeriod`
- **vs** = that rep's visit stats from §5

| Field | UI label | Formula |
|---|---|---|
| `total_leads` | All Leads | `|L|` |
| `valid_leads` | Valid Leads | `|V|` |
| `bad_leads` | Bad Leads | `|L| − |V|` |
| `visits` | Visits | `vs.visits` |
| `write_ups` | Write-ups | `vs.write_ups` |
| `delivered` | Deliveries | `|D|` |
| `conv_pct` | **Cov%** | `|D| / |V|` (0 if `|V| = 0`) |
| `valid_to_visit_rate` | **Vis%** | `vs.visits / |V|` (0 if `|V| = 0`) |
| `writeup_rate` | **WU%** | `vs.write_ups / vs.visits` (0 if no visits) |
| `prior_period_deliveries` | "N prior" sub-label | count of `inSalePeriod && !inLeadPeriod` |
| `pending_deliveries` | "N pending sold" sub-label | subset of `D` matching `isPendingSold()` — see §6a |
| `internet_leads` | *(not rendered)* | `|{v ∈ V : Lead Type === 'Internet'}|` |
| `med_adj_min` | *(not rendered)* | see §9 |
| `speed_tier` | *(not rendered)* | see §9 |
| `contact_rate` | *(not rendered)* | `|{v ∈ V : Contacted Indicator === 'Yes'}| / |V|` |
| `multi_ch_rate` | *(not rendered)* | share of V with ≥2 non-empty of last phone / email / text attempt |
| `trades` | *(not rendered)* | `vs.trades` |

### The ten "bad" lead statuses

`BAD_STATUSES` ([index.html:499](public/index.html:499)), matched **exactly** (trimmed) against the
`Lead Status` column:

```
Bad Credit
Bad or no contact information
Dealer test lead
Duplicate lead
No intent to buy
Out of market
Purchased different brand different dealer
Purchased from private party
Purchased same brand different dealer
Requested no further contact
```

### 6a. Sold Pending Finance

A deal that is sold but **not yet funded**. VinSolutions carries this as a
granular `Lead Status` (e.g. `Sold Pending Finance`); which `Lead Status Type` it
rolls up to is store-configurable, so `isPendingSold()` matches on the **status
text** across `Lead Status`, `Lead Status Custom` and `Lead Status Type`, and
stays agnostic about the type:

```
PENDING_SOLD_PATTERNS = sold pending · pending sold · pending finance ·
                        pending financing · pending funding · pending lender ·
                        awaiting finance · awaiting funding
```

Matching is case-insensitive, and `-`, `_`, `/` are normalised to spaces. The
match is a substring test on the whole value, so `Pending Appointment` does
**not** qualify.

`isDelivered()` is therefore `Lead Status Type === 'Sold' || isPendingSold(row)`.
That is correct under either store configuration:

| Store config | Before | After |
|---|---|---|
| Pending rolls up to Type `Sold` | already counted as a delivery | still counted, now **tagged** |
| Pending rolls up to Type `Open` | not counted at all | **counted**, and tagged |

**Dealer policy: pending deals count as deliveries**, and therefore in Cov%. The
at-risk portion is disclosed via `pending_deliveries` — rendered as an amber
`N pending sold` sub-label under the Deliveries cell (rep rows, the TOTALS row,
and the Summary KPI tile), with a tooltip explaining the rule.

**Fall-through is handled by the stateless recompute, not by subtraction logic.**
Every period is re-scored from scratch off a fresh full export, so:

- Deal **funds** → next export shows `Sold`; it stays a delivery, flag clears.
- Deal **reverts** to active / lost / bad → next export no longer matches either
  sold test; it silently drops out (−1) with no adjustment record needed.
- Deal is still pending at month end → it stays counted, and stays flagged.

> ⚠️ **This only self-corrects while the month is still being re-uploaded.**
> Closed months are frozen snapshots: a July deal that falls through in August
> stays in July's stored numbers forever unless July is re-uploaded. A July deal
> that *funds* in August appears again as an August delivery via the existing
> carry-over path (`prior_period_deliveries`, §6), because its
> `Lead Last Modified Date` moves into August while its origination date stays in
> July.

### Cov% (labelled "Conv%" in some places)

`Deliveries ÷ Valid Leads`. Note the **asymmetry of the denominator**:

- The numerator includes carry-over deliveries (lead originated before the
  window) and `extraSales` second-unit deliveries.
- The denominator counts only leads that *originated inside* the window.

Consequently **Cov% can exceed 100%** for a rep who delivered several carry-over
deals in a light lead month. The `prior` sub-label under the Deliveries cell is
the disclosure mechanism for this; the tooltip text is at [index.html:860](public/index.html:860).

### Ordering

Snapshot order: `delivered` desc, tie-broken by `conv_pct` desc
([index.html:666](public/index.html:666)). The table is independently re-sortable on any column
(`sortedReps`, [index.html:868](public/index.html:868)) — default `delivered` desc, `null`/missing
values sort as `−Infinity`, name sorts ascending by default.

---

## 7. Store totals

[index.html:667–669](public/index.html:667). Counts are summed across reps; **rates are recomputed
from the summed counts, not averaged across reps**:

```
totals.conv_pct     = Σdelivered / Σvalid_leads
totals.writeup_rate = Σwrite_ups / Σvisits
totals.rep_count    = number of reps surviving all filters
totVVR (Vis%)       = Σvisits / Σvalid_leads          (computed in tableHTML)
```

This is a weighted (volume-weighted) aggregate, so a high-volume rep moves the
store rate more than a low-volume rep.

`rep_count` drives the "N reps" tag in the context bar.

---

## 8. Colour banding (the only "grading" in the UI)

Thresholds are hard-coded and applied to the *displayed* value only.

**Cov% / Conv%** — `convCls`, [index.html:862](public/index.html:862):

| Band | Range | Colour |
|---|---|---|
| `cg` | ≥ 20% | green `#22c55e` |
| `ca` | ≥ 10% and < 20% | gold `#f5a623` |
| `cr` | < 10% | red `#ef4444` |

**Vis%** — inline in `tableHTML` ([index.html:1090](public/index.html:1090)):
green ≥ 50%, gold ≥ 25%, red below.

**WU%** — inline ([index.html:1091](public/index.html:1091)):
green ≥ 50%, gold ≥ 30%, red below.

**Bad Leads** — red if `> 0`, otherwise a muted em-dash.

These bands apply identically to rep rows and network cards. The totals row is
banded for Cov% only.

---

## 9. Speed Tier (computed, never displayed)

`speed_tier` is fully implemented but **no view renders it**. Its only consumer
is the AI system prompt ([index.html:1354](public/index.html:1354)), which is why
the calculation below is still live code.

The unused render helpers that used to accompany it — `speedPill()`, `fmtMin()`,
and the `.sp` / `.sp-f` / `.sp-s` / `.sp-p` / `.sp-m` / `.sp-n` CSS rules — have
been **deleted**. They were defined and never called from anywhere. If Speed Tier
is ever surfaced in the table, the pill markup will need to be rewritten.

**Population.** Only `Lead Type === 'Internet'` leads that are already in the
*valid* set.

**Per-lead response minutes** ([index.html:647–654](public/index.html:647)):
1. Parse `Adjusted Response Time (Min)`. If `NaN` → discard the lead entirely.
2. If the value is `> 0` → use it.
3. Otherwise (0 or negative) → look at `Last Attempted Phone / Email / Text
   Contact`. If **any** parseable attempt timestamp is `>=` the lead origination
   timestamp, record **0**. If not, discard the lead.

**Aggregate** ([index.html:655–659](public/index.html:655)):
- Require **≥ 3** usable values, else `med_adj_min = null` and `speed_tier = 'N/A'`.
- Median = `sorted[floor(n/2)]` — the **upper** median for even counts, not the
  mean of the two middle values.

**Tiers:**

| Median adjusted response | Tier |
|---|---|
| `< 15 min` | Full |
| `15 – 59.99 min` | Strong |
| `60 – 239.99 min` | Partial |
| `≥ 240 min` (4 h) | Minimum |
| fewer than 3 usable internet leads | N/A |

---

## 10. "All Periods" aggregation

`mergeSnapshotData` ([index.html:874](public/index.html:874)) — used by the store `All Periods` option
and by the Network `All Periods` option. It sums per-rep
`total_leads`, `bad_leads`, `valid_leads`, `visits`, `write_ups`, `delivered`
across every cached monthly snapshot, then recomputes:

```
conv_pct            = delivered / valid_leads
valid_to_visit_rate = visits    / valid_leads
writeup_rate        = write_ups / visits
```

These key names are **load-bearing**: `tableHTML()` and `summaryHTML()` read
`conv_pct`, `valid_to_visit_rate` and `writeup_rate`, so any aggregator feeding
those views must emit exactly these names (see the fixed bug below).

One caveat remains:

> ⚠️ **Cross-month deduplication does not happen.** Dedup runs inside a single
> file. A customer who appears in both the March and April exports is one lead in
> each and two leads in "All Periods". The PII salt is regenerated per upload
> (`makeDedupHasher`, [index.html:548](public/index.html:548)) precisely because cross-period matching
> was never intended.

> **Fixed:** `mergeSnapshotData` used to emit `vis_pct`/`wu_pct` while
> `tableHTML` read `valid_to_visit_rate`/`writeup_rate`. Vis% survived on a
> fallback (`r.valid_leads ? r.visits / r.valid_leads : 0`,
> [index.html:1080](public/index.html:1080)); WU% had none, so `pct(undefined)`
> rendered the literal string `"NaN%"` in the WU% column and the Summary WU% KPI
> whenever "All Periods" was selected. The aggregator now emits the canonical key
> names, and the stale `vis_pct`/`wu_pct` keys — which nothing ever read — are
> gone.

---

## 11. Network Overview

`networkCardsHTML` ([index.html:1172](public/index.html:1172)) and `getNetworkTotals` ([index.html:1136](public/index.html:1136)).

- **Scope:** the 9 non-Airstream stores only. Airstream is summed and displayed
  in its own separate card below a divider, and is **excluded from the Network
  Total bar**.
- **Per-store card:** that store's snapshot totals for the selected period (or
  `mergeSnapshotData` across all its periods when "All Periods" is chosen).
- **Network Total bar:** `Σ total_leads`, `Σ valid_leads`, `Σ delivered` across
  stores that have data for that period, with
  `Cov% = Σdelivered / Σvalid_leads`. The card header shows the count of stores
  contributing (`dataCount`), so a period where only 4 of 9 stores have uploaded
  reads "Network Total · 4 stores".
- Network Cov% is therefore **volume-weighted across stores**, not the mean of
  store Cov% values.

---

## 12. Month-over-Month deltas

Identical logic in two places — `compareHTML` ([index.html:1273–1283](public/index.html:1273)) for a single
store and `networkCardsHTML` ([index.html:1213–1228](public/index.html:1213)) for the network. One card per
**consecutive pair** of selected/available periods, in ascending date order
(`pa → pb`):

| Metric | Formula | Units |
|---|---|---|
| Leads | `pb.total_leads − pa.total_leads` | absolute count |
| Delivered | `pb.delivered − pa.delivered` | absolute count |
| Conv % | `(pb.conv_pct − pa.conv_pct) × 100` | **percentage points**, 1 dp |

Conv% delta renders `—` unless **both** periods have `valid_leads > 0`.
Arrow/colour: `↑` green if `> 0`, `↓` red if `< 0`, `→` neutral if `0`.

The Compare view uses **all-data snapshots only** — the date-range filter is not
applied there (footer: *"Using all-data snapshots per period"*), and the Compare
table shows Leads / Delivered / Conv% per period.

---

## 13. Where the numbers live

| Blob key | Contents |
|---|---|
| `snap_<store>_<period>` | The scored output: `reps[]`, `totals`, `_rawDates` |
| `rows_<store>_<period>` | PII-stripped raw rows + header index `H`, used to **re-score client-side** when a date filter is applied |
| `meta_<store>_<period>` | Index entry: period, label, filename, `rep_count`, `delivered`, `conv_pct` |

The snapshot is always computed with **no date filter**
(`recomputeRaw(rows, H, storeId, null, null)`,
[store-ingest.mjs:496](netlify/functions/store-ingest.mjs:496) — and
`recomputeRaw(..., '', '')` in the browser, [index.html:1396](public/index.html:1396)). Any
date-filtered view is a **fresh client-side recomputation** from the rows blob,
running the exact same `recomputeRaw` function. This is why the two code paths
must stay byte-identical, and why a missing rows blob disables date filtering
rather than silently degrading it.

### PII handling before storage

Storage uses an **allowlist**, not a denylist. `SCORING_COL_HEADERS` names the
28 columns the scoring code can actually reach — derived mechanically from the
`H['...']` mapping in `parseMasterCSVv2` plus `Stock Number`. **Every other column
is blanked** before the rows are cached or uploaded.

On a real 87-column VinSolutions export that drops ~59 columns, including:

| Dropped | Why it mattered |
|---|---|
| `Visit Notes` | free text; 52% populated, avg 171 chars — customer names, callback numbers, deal details |
| `VIN` | quasi-identifier tying a row to a specific unit |
| `Total Gross`, `Total Sale Price` | per-deal financials |
| `Assigned User`, `TO Manager`, `BD Agent`, `Created By User`, `Completed By User`, `Visit Last Edited By` | employee names |
| `Custom1`–`Custom7`, `Sold Count`, ~40 others | not read by any metric |

The retained identity columns are hashed, never stored raw:

- Customer name → salted FNV-style 64-bit hash (two 32-bit lanes, base-36).
- Email → same hash + `@h`.
- Phones → hash folded into a synthetic 10-digit string.

The salt is **fresh per upload** (`Math.random()` + timestamp) and never stored, so
hashes are stable *within* a period — all dedup needs — and unreversible outside it.

Columns are **blanked in place, not spliced out**: rows are positional arrays
indexed by `H`, so removing a column would shift every later index and silently
corrupt every metric. Row and column counts are unchanged; the values are empty.

Both paths **fail closed** — with no header row, `sanitizeRow`/`stripPii` return
`null` and the caller skips the rows blob entirely rather than persisting the file
untouched, which is what the old code did.

> Verified on a real 338-row export: 282 date-range scenarios comparing raw rows
> against blanked rows produced **zero** differences in `reps[]` or `totals`.

---

## 14. Summary of every displayed figure

| Where | Figure | Calculation |
|---|---|---|
| Store rail | `Nmo` | count of stored periods for that store |
| Store rail | Network `x/y` | stores with ≥1 period ÷ 9 non-Airstream stores |
| Context bar | "N reps" | `totals.rep_count` |
| Rep table | All Leads | in-period deduped leads for the rep |
| Rep table | Bad Leads | in-period leads whose `Lead Status` ∈ `BAD_STATUSES` |
| Rep table | Valid Leads | All Leads − Bad Leads |
| Rep table | Visits | distinct qualifying `Showroom Visit ID`s |
| Rep table | Write-ups | distinct visits with `Write Up = Y` on any of their rows |
| Rep table | Deliveries | `Lead Status Type = Sold` **or** pending-finance, in the sale window, incl. carry-over + extra stock units |
| Rep table | "N pending sold" | deliveries that are sold-but-not-funded (§6a) |
| Rep table | "N prior" | deliveries in window whose lead originated outside it |
| Rep table | Cov% | Deliveries ÷ Valid Leads |
| Rep table | Vis% | Visits ÷ Valid Leads |
| Rep table | WU% | Write-ups ÷ Visits |
| Totals row | all | column sums; rates recomputed from sums |
| Summary KPIs | 5 tiles | same totals, restated |
| Network card | 4 metrics | store totals for the period |
| Network total | 4 metrics | sums across stores with data |
| MoM card | 3 deltas | absolute Δ for counts, percentage-point Δ for Conv% |
| AI prompt | rep lines | adds Internet, Speed tier, Contact%, MultiCh% — none of which appear in the UI |

---

## 15. Issue log

### Resolved

1. ✅ **`NaN%` in the WU% column on "All Periods"** (§10). `mergeSnapshotData` now
   emits `writeup_rate` / `valid_to_visit_rate` instead of the never-read
   `wu_pct` / `vis_pct`.
2. ✅ **Filename→period parsers disagreed** between browser and server ingest
   (§1). Both now run one byte-identical parser accepting `dd_mm_yy`, month
   names, month abbreviations, and trailing suffix tokens — a strict superset of
   what either side accepted before. An out-of-range month now returns `null`
   rather than a nonsense period like `2026-15`.
3. ✅ **Visits were not deduplicated by `Showroom Visit ID`** (§5). Rows are now
   collapsed to one entry per visit ID, with `Write Up` / `Trade Appraisal` OR-ed
   across the visit's rows. **Requires re-uploading past periods** to rewrite
   their stored snapshots — see the warning in §5.
5. ✅ **Dead render helpers removed** (§9): `speedPill()`, `fmtMin()`, and the
   `.sp*` CSS rules. The underlying `speed_tier`, `contact_rate`,
   `multi_ch_rate` and `trades` calculations are **kept** — they still feed the
   AI system prompt.

### Added

9. ✅ **Sold Pending Finance is now explicitly recognised** (§6a). Counted as a
   delivery per dealer policy, flagged with an amber `N pending sold` sub-label,
   and matched on status *text* so the rule is correct whichever `Lead Status
   Type` your store rolls it up to. Fall-throughs self-correct on the next
   re-score of the live month; closed months stay frozen.
10. ✅ **User-facing Methodology tab** — a `ⓘ Methodology` button in the top bar
   (deliberately **not** behind the admin lock) opens a full explanation of every
   column, the exclusion list, what counts as a delivery, dedup, date handling and
   the colour bands. It includes a **live diagnostic** listing every
   `Lead Status` / `Lead Status Type` value present in the loaded data with row
   counts, marking which ones count as delivered, which are pending-finance, and
   which are bad leads — so "is *this* status being counted?" is answerable from
   the dashboard itself.

11. ✅ **PII stripping flipped from a denylist to an allowlist** (§13), and made
   **fail closed**. Confirmed live on a real export: `Visit Notes` was 52%
   populated at ~171 chars/row and shipped verbatim to an unauthenticated
   endpoint. Now dropped along with VIN, deal financials and employee names —
   59 of 87 columns. Metrics verified byte-identical across 282 date-range
   scenarios. Uploaded payload shrank 39%.
12. ✅ **`Purchased same brand different dealer` added to `BAD_STATUSES`** — it was
   the only "purchased elsewhere" status not disqualifying a lead.

### Accepted as intended

4. ⬜ **Cov% > 100% is reachable** (§6) — accepted. Deliveries deliberately
   include leads that originated in an earlier month but closed in this one, so
   the numerator can outrun a denominator that only counts leads originating in
   the window. The `N prior` sub-label under the Deliveries cell discloses how
   much of the count came from outside the window.

### Still open

6. ⬜ **The 20-name blacklist is hard-coded and global** across all 10 rooftops
   (§2) — it requires a code deploy to change and cannot express "manager at
   Hammond, rep at Tupelo".
7. ⬜ **Transitive dedup on shared phone numbers** can merge distinct customers
   (§3) — a shared household or business line collapses two people into one.
8. ⬜ **A lead with an unparseable origination date is always treated as
   in-period** ([index.html:623](public/index.html:623)) — safe for full-month
   views, but it leaks into every narrow date range too.
