// GET /api/admin-auth?password=...
// Validates a candidate admin password against DASHBOARD_PASSWORD.
// If no env var is set, admin actions are unlocked (frictionless local dev).

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const expectedPassword = process.env.DASHBOARD_PASSWORD;
  const suppliedPassword = new URL(request.url).searchParams.get('password');
  const ok = !expectedPassword || suppliedPassword === expectedPassword;

  return Response.json({ ok }, { status: 200, headers: CORS });
};
