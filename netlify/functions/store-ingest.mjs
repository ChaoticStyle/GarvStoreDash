// POST /api/store-ingest
// Body: JSON { apiKey, storeId, csvText, fileName }
// Runs the full CSV parse + scoring pipeline server-side, then stores results
// in Netlify Blobs exactly as upload.mjs does (snap, rows, meta keys).
// Called by the combined VinSolutions Gmail bot.

import { getStore } from '@netlify/blobs';

const BLOB_STORE = 'sdash';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Period helpers ────────────────────────────────────────────────────

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const MONTH_NAME_MAP = {
  jan:'01',january:'01',feb:'02',february:'02',mar:'03',march:'03',
  apr:'04',april:'04',may:'05',jun:'06',june:'06',jul:'07',july:'07',
  aug:'08',august:'08',sep:'09',sept:'09',september:'09',oct:'10',
  october:'10',nov:'11',november:'11',dec:'12',december:'12'
};

// CANONICAL filename → period parser. Must stay byte-identical to the copy in
// public/index.html — the manual browser upload and the automated Gmail ingest
// have to file the same file under the same period, or the two paths silently
// create two different months from one CSV.
// Accepted, in order:
//   1. <store>_<dd>_<mm>_<yy>.csv           hammond_15_03_26.csv       → 2026-03
//   2. <store>_<monthname|abbr>_<yy>.csv    breaux_bridge_june_26.csv  → 2026-06
//   3. ..._<monthname|abbr>_<yy>_<suffix>   hammond_june_26_v2.csv     → 2026-06
function periodFromFileName(name){
  const s=String(name||'');
  // Format 1: storename_dd_mm_yy.csv — day first, month second.
  const m1=s.match(/_(\d{2})_(\d{2})_(\d{2})\.csv$/i);
  if(m1){const mm=m1[2],yy=m1[3];if(+mm>=1&&+mm<=12)return`20${yy}-${mm}`;}
  // Format 2: storename_monthname_yy.csv  (e.g. hattiesburg_march_26.csv)
  const m2=s.match(/_([a-z]+)_(\d{2})\.csv$/i);
  if(m2){const mm=MONTH_NAME_MAP[m2[1].toLowerCase()];if(mm)return`20${m2[2]}-${mm}`;}
  // Format 3: as above but with trailing suffix tokens — scan right-to-left.
  const tokens=s.replace(/\.csv$/i,'').toLowerCase().split('_');
  for(let i=tokens.length-1;i>=1;i--){
    if(!/^\d{2}$/.test(tokens[i]))continue;
    const mm=MONTH_NAME_MAP[tokens[i-1]];
    if(mm)return`20${tokens[i]}-${mm}`;
  }
  return null;
}

// "2026-06" → "Jun 2026". Mirrors periodLabel() in public/index.html.
function labelFromPeriod(period) {
  const [year, month] = String(period || '').split('-');
  return (MONTH_ABBR[parseInt(month, 10) - 1] || month) + ' ' + year;
}

// ── Scoring logic ─────────────────────────────────────────────────────
// Ported verbatim from public/index.html (lines ~385–600).
// Pure JS — no browser APIs used in these functions.

const AIRSTREAM_RULES = {
  LEAD_SOURCE_CONTAINS:       ['airstream','aimbase'],
  LEAD_SOURCE_GROUP_CONTAINS: ['airstream'],
  MAKE_CONTAINS:              ['airstream'],
  BAD_LEAD_STATUS_CUSTOM:     ['bad'],
  BAD_LEAD_STATUS_TYPE:       ['bad'],
};
function isAirstreamLead(row, H) {
  const src  = (row[H.LEAD_SOURCE]    || '').trim().toLowerCase();
  const grp  = (row[H.LEAD_SRC_GROUP] || '').trim().toLowerCase();
  const make = (row[H.MAKE]           || '').trim().toLowerCase();
  if (src)  { for (const v of AIRSTREAM_RULES.LEAD_SOURCE_CONTAINS)       if (src.includes(v))  return true; }
  if (grp)  { for (const v of AIRSTREAM_RULES.LEAD_SOURCE_GROUP_CONTAINS) if (grp.includes(v))  return true; }
  if (make) { for (const v of AIRSTREAM_RULES.MAKE_CONTAINS)              if (make.includes(v)) return true; }
  return false;
}
function isAirstreamBadStatus(row, H) {
  const custom = (row[H.LEAD_STATUS_CUSTOM] || '').trim().toLowerCase();
  const type   = (row[H.LEAD_STATUS_TYPE]   || '').trim().toLowerCase();
  if (custom) { for (const v of AIRSTREAM_RULES.BAD_LEAD_STATUS_CUSTOM) if (custom === v) return true; }
  if (type)   { for (const v of AIRSTREAM_RULES.BAD_LEAD_STATUS_TYPE)   if (type   === v) return true; }
  return false;
}

const normName = n => String(n || '').trim().replace(/\s+/g, ' ').toLowerCase();
const BLACKLIST = new Set([
  'Tony Vitrano','Christian Borrouso','Shane Roberts','Pete Smith',
  'Tyler Zimmerman','Ed Savage','Joe Steffen','Joshua Brevick',
  'James Duos','Justin Mire','James Murphy','Tommy Sacran',
  'Jerry Jones','Chris Seehorn','Matthew Kramer','Mike Lindemood',
  'Michael Lindemood',
  'Steve Smith','Bradley Smart','John Schuster',
].map(normName));
const SYS_PATTERNS = ['your friends at great american rv', 'yod house agent'];
const MGR_GROUPS   = new Set(['Manager', 'Reception', 'Admin']);
const isSysAccount  = name => { const n = normName(name); return SYS_PATTERNS.some(p => n.includes(p)); };
const isTrackedRep  = (storeId, name) => {
  const n = normName(name);
  if (!n) return false;
  if (BLACKLIST.has(n)) return false;
  if (isSysAccount(n)) return false;
  return true;
};
const BAD_STATUSES = new Set([
  'Bad Credit','Bad or no contact information','Dealer test lead','Duplicate lead',
  'No intent to buy','Out of market','Purchased different brand different dealer',
  'Purchased from private party','Purchased same brand different dealer','Requested no further contact',
]);

function parseMasterCSVv2(txt) {
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < txt.length; i++) {
    const ch = txt[i];
    if (inQ) {
      if (ch === '"') { if (txt[i+1] === '"') { field += '"'; i++; } else { inQ = false; } }
      else { field += ch; }
    } else {
      if (ch === '"')       { inQ = true; }
      else if (ch === ',')  { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch === '\r') {}
      else                  { field += ch; }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (rows.length < 2) return null;
  rows[0][0] = rows[0][0].replace(/^﻿/, '');
  const header = rows[0];
  const H = {};
  for (let i = 0; i < header.length; i++) {
    const name = header[i].trim();
    if (!(name in H)) H[name] = i; else H[name + '_2'] = i;
  }
  H.allHeaders        = header.map(h => h.trim());
  H.LEAD_SOURCE       = H['Lead Source'];
  H.LEAD_TYPE         = H['Lead Type'];
  H.LEAD_SRC_GROUP    = H['Lead Source Group'];
  H.LEAD_STATUS       = H['Lead Status'];
  H.LEAD_STATUS_CUSTOM= H['Lead Status Custom'];
  H.LEAD_STATUS_TYPE  = H['Lead Status Type'];
  H.ADJ_RT            = H['Adjusted Response Time (Min)'];
  H.CONTACTED         = H['Contacted Indicator'];
  H.SALES_REP         = H['Sales Rep'];
  H.MAKE              = H['Make'];
  H.LEAD_ORIG         = H['Lead Origination Date'];
  H.LEAD_MOD          = H['Lead Last Modified Date'];
  H.CUSTOMER          = H['Customer'];
  H.DEALER            = H['Dealer'];
  H.LAST_EMAIL        = H['Last Attempted Email Contact'];
  H.LAST_PHONE        = H['Last Attempted Phone Contact'];
  H.LAST_TEXT         = H['Last Attempted Text Contact Datetime'];
  H.EMAIL             = H['Email'];
  H.DAY_PHONE         = H['Daytime Phone'];
  H.EVE_PHONE         = H['Evening Phone'];
  H.CELL_PHONE        = H['Cell Phone'];
  H.VISIT_ID          = H['Showroom Visit ID'];
  H.ASSIGNED_GROUP    = H['Assigned User - User Group'];
  H.VISIT_RESULT      = H['Visit Result'];
  H.WRITE_UP          = H['Write Up'];
  H.TRADE_APP         = H['Trade Appraisal'];
  H.VISIT_START       = H['Visit Start Date'];
  return { rows: rows.slice(1).filter(r => r.length > 1), H };
}

const normPhone = p => { const d = String(p||'').replace(/\D/g,''); const s = d.length===11&&d.startsWith('1')?d.slice(1):d; return s.length===10?s:''; };
const normEmail = e => { const s = String(e||'').trim().toLowerCase(); return s.includes('@')?s:''; };
const normCust  = c => String(c||'').trim().toLowerCase().replace(/\s+/g,' ');
/* SOLD PENDING FINANCE — a deal that is sold but not yet funded.
   VinSolutions carries this as a granular Lead Status (e.g. "Sold Pending Finance");
   which Lead Status Type it rolls up to varies by store configuration, so match on the
   status text and stay agnostic about the type. This makes the rule correct either way:
   if the store's config already rolls it up to Type 'Sold' the deal was always counted
   and we merely tag it; if it rolls up to 'Open' the deal now gets counted.
   Dealer policy: pending deals COUNT as deliveries, but are flagged so the exposure is
   visible. If the deal later funds it stays a delivery; if it reverts to active/lost/bad
   the next re-score of that month drops it (-1) — which is why the live month must keep
   being re-uploaded, and why closed months stay frozen at whatever they last showed.
   Keep this list in sync with the copy in public/index.html. */
const PENDING_SOLD_PATTERNS = ['sold pending','pending sold','pending finance','pending financing','pending funding','pending lender','awaiting finance','awaiting funding'];
const matchesPendingSold = v => { const s = String(v||'').trim().toLowerCase().replace(/[_\-\/]+/g,' ').replace(/\s+/g,' '); return s ? PENDING_SOLD_PATTERNS.some(pt => s.includes(pt)) : false; };
const isPendingSold = (r, H) => matchesPendingSold(r[H.LEAD_STATUS]) || matchesPendingSold(r[H.LEAD_STATUS_CUSTOM]) || matchesPendingSold(r[H.LEAD_STATUS_TYPE]);
const isDelivered = (r, H) => (r[H.LEAD_STATUS_TYPE]||'').trim() === 'Sold' || isPendingSold(r, H);

function dedupCustomers(rows, H) {
  const n = rows.length;
  const parent = new Array(n); for (let i = 0; i < n; i++) parent[i] = i;
  const find  = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const byName = {}, byEmail = {}, byPhone = {};
  for (let i = 0; i < n; i++) {
    const r  = rows[i];
    const nm = normCust(r[H.CUSTOMER]);
    const em = normEmail(r[H.EMAIL]);
    const phones = [r[H.DAY_PHONE], r[H.EVE_PHONE], r[H.CELL_PHONE]].map(normPhone).filter(Boolean);
    if (nm) { if (byName[nm]  !== undefined) union(i, byName[nm]);  else byName[nm]  = i; }
    if (em) { if (byEmail[em] !== undefined) union(i, byEmail[em]); else byEmail[em] = i; }
    for (const ph of phones) { if (byPhone[ph] !== undefined) union(i, byPhone[ph]); else byPhone[ph] = i; }
  }
  const groups = {};
  for (let i = 0; i < n; i++) { const k = find(i); (groups[k] = groups[k] || []).push(i); }
  const leads = [], extraSales = [];
  const stockIdx = H['Stock Number'];
  for (const k in groups) {
    const idxs = groups[k];
    let best = idxs[0], bestSold = isDelivered(rows[best], H), bestTs = Date.parse(rows[best][H.LEAD_ORIG]||'')||0;
    if (idxs.length > 1) {
      for (let j = 1; j < idxs.length; j++) {
        const i = idxs[j], sold = isDelivered(rows[i], H), ts = Date.parse(rows[i][H.LEAD_ORIG]||'')||0;
        if ((sold && !bestSold) || (sold === bestSold && ts > bestTs)) { best = i; bestSold = sold; bestTs = ts; }
      }
    }
    leads.push(rows[best]);
    if (idxs.length > 1 && stockIdx !== undefined) {
      const bestStock = isDelivered(rows[best], H) ? (rows[best][stockIdx]||'').trim().toLowerCase() : null;
      const seen = new Set(bestStock ? [bestStock] : []);
      for (const i of idxs) {
        if (i === best) continue;
        if (!isDelivered(rows[i], H)) continue;
        const stock = (rows[i][stockIdx]||'').trim().toLowerCase();
        if (!stock || seen.has(stock)) continue;
        seen.add(stock);
        extraSales.push(rows[i]);
      }
    }
  }
  return { leads, extraSales };
}

const PII_COL_HEADERS = ['Customer','Email','Daytime Phone','Day Phone','Cell Phone','Evening Phone'];
// ALLOWLIST — the only columns that may be persisted. Derived from parseMasterCSVv2's
// H.* mapping plus Stock Number: scoring can only reach columns through those keys, so
// nothing outside this list can affect any number. Everything else in the export is
// blanked — VIN, Total Gross, Total Sale Price, Visit Notes, employee-name columns.
// Keep in sync with public/index.html and upload.mjs.
const SCORING_COL_HEADERS = [
  'Customer','Email','Daytime Phone','Day Phone','Cell Phone','Evening Phone',
  'Stock Number','Dealer','Lead Source','Lead Source Group','Lead Type','Make',
  'Lead Status','Lead Status Custom','Lead Status Type',
  'Lead Origination Date','Lead Last Modified Date','Visit Start Date',
  'Adjusted Response Time (Min)','Contacted Indicator',
  'Last Attempted Phone Contact','Last Attempted Email Contact','Last Attempted Text Contact Datetime',
  'Sales Rep','Showroom Visit ID','Assigned User - User Group',
  'Visit Result','Write Up','Trade Appraisal',
];

function recomputeRaw(rows, H, storeId, fromStr, toStr) {
  const isAirstreamTab = storeId === 'airstream';
  const filtered = rows.filter(r => {
    const src = (r[H.LEAD_SOURCE]    || '').trim();
    const grp = (r[H.LEAD_SRC_GROUP] || '').trim();
    if (isAirstreamTab) {
      if (src.toLowerCase().includes('700')) return false;
      if (grp.toLowerCase().includes('700')) return false;
    } else {
      if (src === '700credithmd' || grp === '700 Credit') return false;
    }
    const isAirstream = isAirstreamLead(r, H);
    if (isAirstreamTab) { if (!isAirstream) return false; if (isAirstreamBadStatus(r, H)) return false; }
    else                { if (isAirstream)  return false; }
    const rep = (r[H.SALES_REP] || '').trim();
    if (!rep || !isTrackedRep(storeId, rep)) return false;
    return true;
  });

  const { leads: dedup, extraSales } = dedupCustomers(filtered, H);
  // Date-only strings parse as UTC midnight per spec, then .setHours() mutates in
  // local time — on a timezone behind UTC this silently lands toMs on the PREVIOUS
  // local day's end of day, dropping the entire last day of a bounded range.
  // Appending an explicit local time avoids the UTC round-trip entirely.
  const fromMs = fromStr ? new Date(fromStr + 'T00:00:00.000').getTime() : null;
  const toMs   = toStr   ? new Date(toStr   + 'T23:59:59.999').getTime() : null;
  const inRange = ms => { if (isNaN(ms)) return false; if (fromMs !== null && ms < fromMs) return false; if (toMs !== null && ms > toMs) return false; return true; };
  const noFilter = (fromMs === null && toMs === null);

  // One Showroom Visit ID = one visit. The same visit rides along on every lead row
  // belonging to that customer, so tallying per row counted it once per row —
  // inflating visits (and Vis%) and deflating WU%. Collapse to one entry per ID
  // first: rep is first-seen-wins, and Write Up / Trade Appraisal are OR-ed across
  // the visit's rows so a flag set on any single row still counts exactly once.
  const visitById = new Map();
  filtered.forEach(r => {
    const vid = (r[H.VISIT_ID] || '').trim(); if (!vid) return;
    if ((r[H.VISIT_RESULT] || '').trim() === 'Deleted') return;
    const ag  = (r[H.ASSIGNED_GROUP] || '').trim(); if (MGR_GROUPS.has(ag)) return;
    const rep = (r[H.SALES_REP]      || '').trim(); if (!rep) return;
    if (!noFilter) { const vStartMs = Date.parse(r[H.VISIT_START] || ''); if (!inRange(vStartMs)) return; }
    const wu = (r[H.WRITE_UP]  || '').trim() === 'Y';
    const tr = (r[H.TRADE_APP] || '').trim() === 'Y';
    const v  = visitById.get(vid);
    if (v) { if (wu) v.wu = true; if (tr) v.tr = true; return; }
    visitById.set(vid, { rep, wu, tr });
  });
  const visitStats = {};
  visitById.forEach(v => {
    const s = visitStats[v.rep] = visitStats[v.rep] || { visits: 0, write_ups: 0, trades: 0 };
    s.visits++;
    if (v.wu) s.write_ups++;
    if (v.tr) s.trades++;
  });

  const classified = dedup.map(r => {
    const origMs = Date.parse(r[H.LEAD_ORIG] || '');
    const modMs  = Date.parse(r[H.LEAD_MOD]  || '');
    const sold   = isDelivered(r, H);
    const inLeadPeriod = noFilter ? true : (isNaN(origMs) ? true : inRange(origMs));
    const saleDateMs   = !isNaN(modMs) ? modMs : origMs;
    const inSalePeriod = sold && (noFilter ? true : inRange(saleDateMs));
    return { row: r, sold, inLeadPeriod, inSalePeriod };
  });

  const keep  = classified.filter(c => c.inLeadPeriod || c.inSalePeriod);
  const byRep = {};
  keep.forEach(c => { const rep = (c.row[H.SALES_REP] || '').trim(); (byRep[rep] = byRep[rep] || []).push(c); });

  extraSales.forEach(r => {
    const modMs2    = Date.parse(r[H.LEAD_MOD]  || '');
    const origMs2   = Date.parse(r[H.LEAD_ORIG] || '');
    const saleDateMs = !isNaN(modMs2) ? modMs2 : origMs2;
    const inSalePeriod = noFilter ? true : (!isNaN(saleDateMs) && inRange(saleDateMs));
    if (!inSalePeriod) return;
    const rep = (r[H.SALES_REP] || '').trim(); if (!rep) return;
    (byRep[rep] = byRep[rep] || []).push({ row: r, sold: true, inLeadPeriod: false, inSalePeriod: true });
  });

  const reps = [];
  Object.entries(byRep).forEach(([rep, cr]) => {
    if (BLACKLIST.has(normName(rep)) || isSysAccount(rep)) return;
    const inPeriodLeads = cr.filter(c => c.inLeadPeriod);
    const validLeads    = inPeriodLeads.filter(c => !BAD_STATUSES.has((c.row[H.LEAD_STATUS] || '').trim()));
    const deliveries    = cr.filter(c => c.inSalePeriod);
    const priorDels     = cr.filter(c => c.inSalePeriod && !c.inLeadPeriod).length;
    // Subset of deliveries that are sold-but-not-yet-funded. Counted in `delivered`
    // above; surfaced separately so the at-risk portion of the number is visible.
    const pendingDels   = deliveries.filter(c => isPendingSold(c.row, H)).length;
    const internet      = validLeads.filter(c => (c.row[H.LEAD_TYPE] || '').trim() === 'Internet');
    const adj = [];
    internet.forEach(c => {
      const v = parseFloat(c.row[H.ADJ_RT]);
      if (isNaN(v)) return;
      if (v > 0) { adj.push(v); return; }
      const leadTs   = Date.parse(c.row[H.LEAD_ORIG] || '');
      if (isNaN(leadTs)) return;
      const attempts = [c.row[H.LAST_PHONE], c.row[H.LAST_EMAIL], c.row[H.LAST_TEXT]]
        .map(s => Date.parse(s || '')).filter(t => !isNaN(t));
      if (attempts.some(t => t >= leadTs)) adj.push(0);
    });
    const median = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
    const mA = adj.length >= 3 ? median(adj) : null;
    let speedTier = 'N/A';
    if (mA !== null) {
      if (mA < 15)  speedTier = 'Full';
      else if (mA < 60)  speedTier = 'Strong';
      else if (mA < 240) speedTier = 'Partial';
      else               speedTier = 'Minimum';
    }
    const contacted   = validLeads.filter(c => (c.row[H.CONTACTED] || '').trim() === 'Yes').length;
    const contactRate = validLeads.length ? contacted / validLeads.length : 0;
    const multi       = validLeads.filter(c => {
      let cnt = 0;
      if (c.row[H.LAST_PHONE]?.trim()) cnt++;
      if (c.row[H.LAST_EMAIL]?.trim()) cnt++;
      if (c.row[H.LAST_TEXT]?.trim())  cnt++;
      return cnt >= 2;
    }).length;
    const multiChRate = validLeads.length ? multi / validLeads.length : 0;
    const vs = visitStats[rep] || { visits: 0, write_ups: 0, trades: 0 };
    reps.push({
      name: rep,
      total_leads: inPeriodLeads.length,
      valid_leads: validLeads.length,
      bad_leads:   inPeriodLeads.length - validLeads.length,
      delivered:   deliveries.length,
      conv_pct:    validLeads.length ? deliveries.length / validLeads.length : 0,
      internet_leads: internet.length,
      med_adj_min: mA,
      speed_tier:  speedTier,
      contact_rate:    contactRate,
      multi_ch_rate:   multiChRate,
      visits:          vs.visits,
      write_ups:       vs.write_ups,
      writeup_rate:    vs.visits ? vs.write_ups / vs.visits : 0,
      valid_to_visit_rate: validLeads.length ? vs.visits / validLeads.length : 0,
      trades:              vs.trades,
      prior_period_deliveries: priorDels,
      pending_deliveries:      pendingDels,
    });
  });

  reps.sort((a, b) => b.delivered - a.delivered || b.conv_pct - a.conv_pct);

  const totals = {
    total_leads:    reps.reduce((s, r) => s + r.total_leads,    0),
    valid_leads:    reps.reduce((s, r) => s + r.valid_leads,    0),
    bad_leads:      reps.reduce((s, r) => s + r.bad_leads,      0),
    delivered:      reps.reduce((s, r) => s + r.delivered,      0),
    pending_deliveries: reps.reduce((s, r) => s + (r.pending_deliveries || 0), 0),
    conv_pct:       0,
    visits:         reps.reduce((s, r) => s + r.visits,         0),
    write_ups:      reps.reduce((s, r) => s + r.write_ups,      0),
    writeup_rate:   0,
    rep_count:      reps.length,
    internet_leads: reps.reduce((s, r) => s + r.internet_leads, 0),
  };
  totals.conv_pct     = totals.valid_leads ? totals.delivered / totals.valid_leads : 0;
  totals.writeup_rate = totals.visits      ? totals.write_ups  / totals.visits     : 0;

  const allDates = rows
    .map(r => r[H.LEAD_ORIG] || '').filter(Boolean)
    .map(s => {
      if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) {
        const [m, d, y] = s.slice(0, 10).split('/');
        return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
      }
      return s.slice(0, 10);
    })
    .filter(s => /^\d{4}-\d{2}-\d{2}/.test(s));

  return { reps, totals, _rawDates: [...new Set(allDates)].sort() };
}

// ── PII strip for rows blob ───────────────────────────────────────────

// Deterministic, salted hash so dedup matching (same Customer/Email/Phone => same
// customer) still works on the sanitised rows blob used for client-side date-range
// re-filtering. Salt is fresh per ingestion call and is never stored, so the hashes are
// not reversible; dedup only needs to match within one period's own rows.
function makeDedupHasher() {
  const salt = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return v => {
    const s = salt + '|' + String(v || '');
    let h1 = 0x811c9dc5, h2 = 0x1b873593;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2246822519) >>> 0; }
    return h1.toString(36) + h2.toString(36);
  };
}
function hashPhoneDigits(hash, raw) {
  const ph = normPhone(raw); if (!ph) return '';
  const h = hash(ph); let n = 0; for (let i = 0; i < h.length; i++) n = (n * 31 + h.charCodeAt(i)) >>> 0;
  return String(n).padStart(10, '0').slice(-10);
}

// Fail CLOSED: without a header row we cannot tell which columns are safe, so return
// null and let the caller skip the rows blob rather than persist the file untouched.
function stripPii(rows, H, hash) {
  if (!Array.isArray(H.allHeaders) || !H.allHeaders.length) return null;
  const keep = new Set();
  H.allHeaders.forEach((h, i) => { if (SCORING_COL_HEADERS.includes(String(h || '').trim())) keep.add(i); });
  const hdr = H.allHeaders;
  return rows.map(row => {
    const out = row.slice();
    for (let i = 0; i < out.length; i++) {
      if (!keep.has(i)) { out[i] = ''; continue; }        // outside the allowlist -> dropped
      if (i === H.CUSTOMER) { const nm = normCust(out[i]); out[i] = nm ? hash(nm) : ''; }
      else if (i === H.EMAIL) { const em = normEmail(out[i]); out[i] = em ? hash(em) + '@h' : ''; }
      else if (i === H.DAY_PHONE || i === H.EVE_PHONE || i === H.CELL_PHONE) { out[i] = hashPhoneDigits(hash, out[i]); }
      else if (PII_COL_HEADERS.includes(String(hdr[i] || '').trim())) { out[i] = ''; }  // duplicate PII column
    }
    return out;
  });
}

// ── H serialisation (strip internal caches before storing) ───────────

function serializeH(H) {
  const out = {};
  for (const k of Object.keys(H)) {
    if (k === '_piiCols') continue;
    if (typeof H[k] === 'number' || k === 'allHeaders') out[k] = H[k];
  }
  return out;
}

// ── Handler ───────────────────────────────────────────────────────────

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: CORS });
  }

  const expectedKey = process.env.STORE_INGEST_API_KEY;
  if (!expectedKey) {
    console.error('STORE_INGEST_API_KEY env var not set');
    return Response.json({ error: 'Server misconfiguration' }, { status: 500, headers: CORS });
  }

  let body;
  try { body = await req.json(); }
  catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: CORS }); }

  const { apiKey, storeId, csvText, fileName } = body || {};

  if (apiKey !== expectedKey) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS });
  }
  if (!storeId || !csvText) {
    return Response.json({ error: 'storeId and csvText are required' }, { status: 400, headers: CORS });
  }

  // Derive period from fileName
  const period = periodFromFileName(fileName || '');
  if (!period) {
    return Response.json(
      { error: `Cannot derive period from fileName "${fileName}". Expected store_month_YY.csv or store_DD_MM_YY.csv` },
      { status: 400, headers: CORS }
    );
  }
  const label = labelFromPeriod(period);

  // Parse CSV
  const parsed = parseMasterCSVv2(csvText);
  if (!parsed) {
    return Response.json({ error: 'CSV has fewer than 2 rows or could not be parsed' }, { status: 400, headers: CORS });
  }
  const { rows, H } = parsed;

  // Validate it looks like a master lead export
  if (H.SALES_REP === undefined || H.VISIT_RESULT === undefined || H.WRITE_UP === undefined || H.CONTACTED === undefined) {
    return Response.json(
      { error: 'CSV does not look like a VinSolutions master lead export (missing required columns)' },
      { status: 400, headers: CORS }
    );
  }

  // Score
  const snapshot = recomputeRaw(rows, H, storeId, null, null);

  // Store blobs
  const store = getStore(BLOB_STORE);
  const now   = new Date().toISOString();

  try {
    await store.setJSON(`snap_${storeId}_${period}`, {
      ...snapshot,
      period,
      label,
      fileName:   fileName || '',
      uploadedAt: now,
    });
  } catch (e) {
    console.error(`snap blob write failed for ${storeId}/${period}:`, e.message);
    return Response.json({ error: 'Failed to store snapshot' }, { status: 500, headers: CORS });
  }

  try {
    const cleanRows = stripPii(rows, H, makeDedupHasher());
    if (!cleanRows) throw new Error('row sanitisation failed — refusing to store rows');
    await store.setJSON(`rows_${storeId}_${period}`, {
      rows:       cleanRows,
      H:          serializeH(H),
      fileName:   fileName || '',
      uploadedAt: now,
    });
  } catch (e) {
    // Non-fatal — snapshot is already stored; rows are only needed for date filtering.
    console.warn(`rows blob write failed for ${storeId}/${period}:`, e.message);
  }

  try {
    await store.setJSON(`meta_${storeId}_${period}`, {
      period,
      label,
      fileName:   fileName || '',
      uploadedAt: now,
      rep_count:  snapshot.totals?.rep_count || 0,
      delivered:  snapshot.totals?.delivered || 0,
      conv_pct:   snapshot.totals?.conv_pct  || 0,
    });
  } catch (e) {
    console.warn(`meta blob write failed for ${storeId}/${period}:`, e.message);
  }

  return Response.json({
    ok:       true,
    storeId,
    period,
    label,
    repCount: snapshot.totals?.rep_count || 0,
    delivered: snapshot.totals?.delivered || 0,
  }, { headers: CORS });
};
