// GET /api/store/:id/period/:period/rows
// Returns PII-stripped row cache for a period — used for client-side date-range re-scoring.

import { getStore } from '@netlify/blobs';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  // URL: /api/store/:id/period/:period/rows
  // parts: ['', 'api', 'store', id, 'period', period, 'rows']
  const parts  = new URL(req.url).pathname.split('/');
  const id     = parts[3];
  const period = parts[5];

  if (!id || !period) {
    return Response.json({ error: 'Missing store id or period' }, { status: 400, headers: CORS });
  }

  try {
    const rows = await getStore('sdash').get(`rows_${id}_${period}`, { type: 'json' });
    if (!rows) return new Response('Not found', { status: 404, headers: CORS });
    return Response.json(rows, { headers: CORS });
  } catch {
    return new Response('Not found', { status: 404, headers: CORS });
  }
};
