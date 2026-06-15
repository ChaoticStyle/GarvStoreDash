// /api/ai — proxies to Anthropic's Messages API using a server-side key.
// Expects POST body: { model, max_tokens, system, messages }
//
// v4.3 (May 2026):
//   - Default model bumped to claude-sonnet-4-6
//   - Empty `system` field omitted instead of sent as ""
//   - Reject empty `messages` arrays before the round-trip
//   - Outbound fetch has a 25s timeout (just inside Netlify's 26s limit)
//   - Default max_tokens raised to 1024 to cover longer AI Coach replies

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 1024;
const UPSTREAM_TIMEOUT_MS = 25_000;

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: CORS });
  }

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY') || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'ANTHROPIC_API_KEY env var not set on the Netlify site.' },
      { status: 500, headers: CORS }
    );
  }

  // Optional AI-gateway indirection. Lets us route through Vercel, Cloudflare,
  // Requesty, etc. by flipping one env var — no code change required.
  const baseUrl = Netlify.env.get('ANTHROPIC_BASE_URL')
    || process.env.ANTHROPIC_BASE_URL
    || 'https://api.anthropic.com';

  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: CORS });
  }

  // Validate before paying the network round-trip.
  const messages = Array.isArray(payload.messages) ? payload.messages : null;
  if (!messages || messages.length === 0) {
    return Response.json(
      { error: '`messages` must be a non-empty array' },
      { status: 400, headers: CORS }
    );
  }

  // Build body. Only include `system` when caller actually provided one —
  // sending an empty string works but is slightly noisier than omitting it.
  const body = {
    model: payload.model || DEFAULT_MODEL,
    max_tokens: payload.max_tokens || DEFAULT_MAX_TOKENS,
    messages,
  };
  if (typeof payload.system === 'string' && payload.system.trim()) {
    body.system = payload.system;
  }
  // Pass through optional sampling params if the caller sets them.
  for (const k of ['temperature', 'top_p', 'top_k', 'stop_sequences', 'metadata']) {
    if (payload[k] !== undefined) body[k] = payload[k];
  }

  // Outbound fetch with an explicit timeout — Netlify's sync function limit
  // is 26s; we abort just before that so we can still return a clean 504.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      return Response.json(
        { error: `Upstream timeout after ${UPSTREAM_TIMEOUT_MS / 1000}s` },
        { status: 504, headers: CORS }
      );
    }
    return Response.json(
      { error: 'Upstream error: ' + e.message },
      { status: 502, headers: CORS }
    );
  } finally {
    clearTimeout(timer);
  }
};
