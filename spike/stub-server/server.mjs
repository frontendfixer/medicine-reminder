// Phase 0 stub endpoint. No dependencies: `node server.mjs`.
// - POST /v1/device/dose-responses  stores answers, idempotent per client_event_id
// - GET  /answers                   lists stored answers with received_at
// - POST /push  { to, kind }        sends an Expo data push (D-075 test) and returns the ticket
// - POST /receipts { ids }          fetches Expo push receipts
// Data is kept in answers.json next to this file. Throwaway: not the Phase 1 API.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 8787);
const STORE = new URL('./answers.json', import.meta.url);
const EXPO_ACCESS_TOKEN = process.env.EXPO_ACCESS_TOKEN; // only if enhanced push security is on

const answers = existsSync(STORE) ? JSON.parse(readFileSync(STORE, 'utf8')) : [];
const save = () => writeFileSync(STORE, JSON.stringify(answers, null, 2));

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function expo(path, payload) {
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  if (EXPO_ACCESS_TOKEN) headers.authorization = `Bearer ${EXPO_ACCESS_TOKEN}`;
  const r = await fetch(`https://exp.host/--/api/v2/push/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  return { status: r.status, body: await r.json() };
}

createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/v1/device/dose-responses') {
      const { responses = [] } = await readJson(req);
      const results = responses.slice(0, 100).map((r) => {
        if (answers.some((a) => a.client_event_id === r.client_event_id)) {
          return { client_event_id: r.client_event_id, outcome: 'duplicate' };
        }
        answers.push({
          ...r,
          received_at: new Date().toISOString(),
          platform: req.headers['x-platform'] ?? null,
          idempotency_key: req.headers['idempotency-key'] ?? null,
        });
        return { client_event_id: r.client_event_id, outcome: 'applied' };
      });
      save();
      console.log(new Date().toISOString(), 'dose-responses', JSON.stringify(results));
      return send(res, 200, { results });
    }
    if (req.method === 'GET' && req.url === '/answers') return send(res, 200, answers);
    if (req.method === 'POST' && req.url === '/push') {
      const { to, kind = 'sync' } = await readJson(req);
      // Data only: no title/body. priority high on Android, contentAvailable on iOS (R-08).
      const ticket = await expo('send', {
        to,
        priority: 'high',
        contentAvailable: true,
        data: { kind, sent_at: new Date().toISOString() },
      });
      console.log(new Date().toISOString(), 'push', kind, JSON.stringify(ticket.body));
      return send(res, ticket.status, ticket.body);
    }
    if (req.method === 'POST' && req.url === '/receipts') {
      const { ids = [] } = await readJson(req);
      const r = await expo('getReceipts', { ids });
      return send(res, r.status, r.body);
    }
    send(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found', details: {} } });
  } catch (e) {
    send(res, 400, { error: { code: 'VALIDATION_FAILED', message: String(e), details: {} } });
  }
}).listen(PORT, () => console.log(`stub listening on :${PORT}`));
