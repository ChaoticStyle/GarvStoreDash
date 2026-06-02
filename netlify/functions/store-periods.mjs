// GET /api/store/:id/periods
// Returns the period index (lightweight metadata list) for one store.

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

  try {
    const index = (await getStore('sdash').get(`index_${id}`, { type: 'json' })) || [];
    return Response.json(index, { headers: CORS });
  } catch {
    return Response.json([], { headers: CORS });
  }
};
