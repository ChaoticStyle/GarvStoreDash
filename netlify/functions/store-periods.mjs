// GET /api/store/:id/periods
// Returns the period index (lightweight metadata list) for one store.
// Rebuilt from individual meta_storeId_period blobs — no shared index blob,
// so concurrent uploads cannot race and lose entries.

import { getStore } from '@netlify/blobs';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  // Parse :id from URL path: /api/store/:id/periods
  const parts = new URL(req.url).pathname.split('/');
  const id    = parts[3]; // ['', 'api', 'store', id, 'periods']

  if (!id) return Response.json({ error: 'Missing store id' }, { status: 400, headers: CORS });

  const store = getStore('sdash');

  try {
    // List all per-period metadata blobs for this store
    const { blobs } = await store.list({ prefix: `meta_${id}_` });

    if (blobs && blobs.length > 0) {
      // Fetch all meta blobs in parallel — each is tiny (just metadata, no reps array)
      const metas = await Promise.all(
        blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
      );
      const index = metas
        .filter(Boolean)
        .sort((a, b) => b.period.localeCompare(a.period));
      return Response.json(index, { headers: CORS });
    }

    // Fallback: legacy index blob (for stores uploaded before this fix)
    const legacy = (await store.get(`index_${id}`, { type: 'json' })) || [];
    return Response.json(legacy, { headers: CORS });
  } catch {
    return Response.json([], { headers: CORS });
  }
};
