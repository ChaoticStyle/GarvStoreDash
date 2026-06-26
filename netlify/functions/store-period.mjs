// GET  /api/store/:id/period/:period  — fetch a full snapshot
// DELETE /api/store/:id/period/:period — delete snapshot + rows + remove from index

import { getStore } from '@netlify/blobs';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  // Parse :id and :period from URL: /api/store/:id/period/:period
  const parts  = new URL(req.url).pathname.split('/');
  const id     = parts[3]; // ['', 'api', 'store', id, 'period', period]
  const period = parts[5];

  if (!id || !period) {
    return Response.json({ error: 'Missing store id or period' }, { status: 400, headers: CORS });
  }

  const store = getStore('sdash');

  if (req.method === 'DELETE') {
    const expectedPassword = process.env.DASHBOARD_PASSWORD;
    const suppliedPassword = new URL(req.url).searchParams.get('password');
    if (expectedPassword && suppliedPassword !== expectedPassword) {
      return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CORS });
    }
    try {
      await Promise.allSettled([
        store.delete(`snap_${id}_${period}`),
        store.delete(`rows_${id}_${period}`),
        store.delete(`meta_${id}_${period}`),
      ]);
    } catch (e) {
      console.warn('delete period failed:', e.message);
    }
    return Response.json({ ok: true }, { headers: CORS });
  }

  // GET
  try {
    const snap = await store.get(`snap_${id}_${period}`, { type: 'json' });
    if (!snap) return new Response('Not found', { status: 404, headers: CORS });
    return Response.json(snap, { headers: CORS });
  } catch {
    return new Response('Not found', { status: 404, headers: CORS });
  }
};
