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

function restrip(payload) {
  if (!payload?.rows || !payload?.H) return payload;
  const headers = Array.isArray(payload.H.allHeaders) ? payload.H.allHeaders : [];
  const pii = new Set();
  headers.forEach((h, i) => { if (PII_COLS.includes(String(h || '').trim())) pii.add(i); });
  PII_COLS.forEach(n => { if (typeof payload.H[n] === 'number') pii.add(payload.H[n]); });
  if (!pii.size) return payload;
  return {
    ...payload,
    rows: payload.rows.map(row => {
      const out = row.slice();
      pii.forEach(i => { if (i >= 0 && i < out.length) out[i] = ''; });
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
