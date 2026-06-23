// POST /api/upload
// Body: JSON { storeId, period, label, fileName, snapshot, rows?, H? }
// Stores the computed period snapshot and (optionally) PII-stripped rows in Netlify Blobs.
// All scoring runs client-side; this function is purely a blob writer.

import { getStore } from '@netlify/blobs';

const BLOB_STORE   = 'sdash';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const PII_COLS = [
  'Customer', 'Email',
  'Daytime Phone', 'Day Phone',
  'Cell Phone', 'Evening Phone',
];

const normPhone = p => { const d = String(p||'').replace(/\D/g,''); const s = d.length===11&&d.startsWith('1')?d.slice(1):d; return s.length===10?s:''; };
const normEmail = e => { const s = String(e||'').trim().toLowerCase(); return s.includes('@')?s:''; };
const normCust  = c => String(c||'').trim().toLowerCase().replace(/\s+/g,' ');

// Deterministic, salted hash so dedup matching (same Customer/Email/Phone => same
// customer) still works on the PII-stripped rows blob — this is a defense-in-depth
// re-strip in case a client ever sends raw PII; the browser already hashes before
// POSTing, so re-hashing here is idempotent for compliant clients. Fresh salt per
// request, since dedup only needs to match within one period's own rows.
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

function restrip(payload) {
  if (!payload?.rows || !payload?.H) return payload;
  const H = payload.H;
  const headers = Array.isArray(H.allHeaders) ? H.allHeaders : [];
  const pii = new Set();
  headers.forEach((h, i) => { if (PII_COLS.includes(String(h || '').trim())) pii.add(i); });
  PII_COLS.forEach(n => { if (typeof H[n] === 'number') pii.add(H[n]); });
  if (!pii.size) return payload;
  const hash = makeDedupHasher();
  return {
    ...payload,
    rows: payload.rows.map(row => {
      const out = row.slice();
      pii.forEach(i => {
        if (i < 0 || i >= out.length) return;
        if (i === H.CUSTOMER) { const nm = normCust(out[i]); out[i] = nm ? hash(nm) : ''; }
        else if (i === H.EMAIL) { const em = normEmail(out[i]); out[i] = em ? hash(em) + '@h' : ''; }
        else if (i === H.DAY_PHONE || i === H.EVE_PHONE || i === H.CELL_PHONE) { out[i] = hashPhoneDigits(hash, out[i]); }
        else out[i] = '';
      });
      return out;
    }),
  };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: CORS });
  }

  let body;
  try { body = await req.json(); }
  catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: CORS }); }

  const { storeId, period, label, fileName, snapshot, rows, H } = body || {};
  if (!storeId || !period) {
    return Response.json({ error: 'storeId and period are required' }, { status: 400, headers: CORS });
  }

  const store = getStore(BLOB_STORE);
  const now   = new Date().toISOString();

  // 1. Store the period snapshot (reps + totals + metadata)
  if (snapshot) {
    await store.setJSON(`snap_${storeId}_${period}`, {
      ...snapshot,
      period,
      label:      label || period,
      fileName:   fileName || '',
      uploadedAt: now,
    });
  }

  // 2. Store PII-stripped rows (for cross-browser date filtering)
  if (rows && H) {
    const clean = restrip({ rows, H, fileName, uploadedAt: now });
    try {
      await store.setJSON(`rows_${storeId}_${period}`, clean);
    } catch (e) {
      // Non-fatal: snapshot already saved; rows are a "nice to have" for date filtering.
      console.warn(`rows blob write failed for ${storeId}/${period}:`, e.message);
    }
  }

  // 3. Write a lightweight metadata blob for this period.
  //    Each period gets its own key — no read-modify-write, no race condition.
  //    store-periods.mjs lists meta_storeId_* to build the index.
  if (snapshot) {
    await store.setJSON(`meta_${storeId}_${period}`, {
      period,
      label:      label || period,
      fileName:   fileName || '',
      uploadedAt: now,
      rep_count:  snapshot.totals?.rep_count  || 0,
      delivered:  snapshot.totals?.delivered  || 0,
      conv_pct:   snapshot.totals?.conv_pct   || 0,
    });
  }

  return Response.json({ ok: true, storeId, period }, { headers: CORS });
};
