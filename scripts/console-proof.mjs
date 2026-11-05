// Live proof of the owner console against the migrated engine: the on
// chain holds queue, token auth, pause, revoke. Assumes the seller and
// the agent demo have already run (so a CAP hold is waiting on chain),
// and the console is up on :8282 with STIPEND_CONSOLE_TOKEN set to the
// CONSOLE_TOKEN given here.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttemptLog, EngineClient } from '../packages/sdk/dist/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'http://localhost:8282';
const TOKEN = process.env['CONSOLE_TOKEN'];
if (!TOKEN) throw new Error('CONSOLE_TOKEN env is required');
const info = JSON.parse(readFileSync(join(ROOT, 'keys/deploy-info.json'), 'utf8'));
const RPC = 'https://rpc.testnet.near.org';
const SELLER_URL = 'http://localhost:8787';
const log = new AttemptLog(join(ROOT, 'data/attempts-stipend.json'));

const agentKey = JSON.parse(
  readFileSync(join(ROOT, 'keys', `${info.engine}.json`), 'utf8'),
);
const agent = new EngineClient({
  networkId: 'testnet',
  nodeUrl: RPC,
  contractId: info.engine,
  accountId: info.engine,
  privateKey: agentKey.private_key,
});

async function api(path, opts = {}, token = TOKEN) {
  const headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
  if (token) headers['x-console-token'] = token;
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function tryBuy(label) {
  const qRes = await fetch(`${SELLER_URL}/vault-quote?resource=data:market-report`);
  const { quote } = await qRes.json();
  const paymentId = `pay_proof_${Date.now()}`;
  try {
    await agent.requestPayment('bot', paymentId, quote, null);
    const record = await agent.pollPayment(paymentId);
    console.log(`${label}: purchase ${record.status}`);
    return record;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = msg.includes('engine paused')
      ? 'PAUSED'
      : msg.includes('agent revoked')
        ? 'REVOKED'
        : 'ERROR';
    console.log(`${label}: blocked [${code}]`);
    return null;
  }
}

// 1. The queue is on chain: find the pending CAP hold from the demo run.
const holdsRes = await api('/api/holds');
const pending = (holdsRes.body ?? []).filter((h) => h.status === 'PendingApproval');
console.log(`pending holds on chain: ${pending.length}`);
const cap = pending.find((h) => h.reason === 'CAP');
if (!cap) throw new Error('no pending CAP hold found; run the agent demo first');
console.log(`hold: ${cap.hold_id} amount=${cap.amount} reason=${cap.reason}`);

// 2. Auth: admin calls without the token, and with a wrong one, refuse.
const noToken = await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: true }) }, null);
const badToken = await api(
  '/api/pause',
  { method: 'POST', body: JSON.stringify({ paused: true }) },
  'wrong-token',
);
console.log(`pause without token: HTTP ${noToken.status}; wrong token: HTTP ${badToken.status}`);
if (noToken.status !== 401 || badToken.status !== 401) throw new Error('console auth is not refusing');

// 3. Approve the hold through the console: decision + execution on chain.
const approve = await api('/api/holds/approve', {
  method: 'POST',
  body: JSON.stringify({ hold_id: cap.hold_id }),
});
console.log(`approve response: HTTP ${approve.status}`);
if (approve.status !== 200) throw new Error(`approve failed: ${JSON.stringify(approve.body)}`);
console.log(`executed payment: ${approve.body.payment_id} -> ${approve.body.status}, ${approve.body.amount} yocto`);
if (approve.body.status !== 'Succeeded') throw new Error('approved hold did not settle');
const holdAfter = await agent.getHold(cap.hold_id);
console.log(`hold after: status=${holdAfter.status} payment_id=${holdAfter.payment_id}`);

// 4. Reject path: file a second hold directly and reject it in the console.
const qRes = await fetch(`${SELLER_URL}/vault-quote?resource=data:deep-dive`);
const { quote } = await qRes.json();
const rejectId = `pay_reject_${Date.now()}`;
await agent.requestHold(rejectId, 'bot', quote);
const reject = await api('/api/holds/reject', {
  method: 'POST',
  body: JSON.stringify({ hold_id: rejectId }),
});
const rejected = await agent.getHold(rejectId);
console.log(`reject: HTTP ${reject.status}, on chain status=${rejected.status}`);

// 5. Pause blocks, resume restores (with the token this time).
await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: true }) });
await tryBuy('while paused');
await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: false }) });

// 6. Revoke blocks, reactivate restores.
await api('/api/agents/bot/revoke', { method: 'POST', body: '{}' });
await tryBuy('while revoked');
await api('/api/agents/bot/reactivate', { method: 'POST', body: '{}' });
await tryBuy('after reactivate');

const day = Math.floor((Date.now() * 1e6) / 86_400_000_000_000);
console.log(`bot spent_today: ${await agent.getSpent('bot', day)} yocto`);
const payments = await agent.listPayments(0, 200);
console.log(
  `payments listed: ${payments.length}, succeeded: ${payments.filter(([, p]) => p.status === 'Succeeded').length}`,
);
const holds = await agent.listHolds(0, 200);
console.log(
  `holds listed: ${holds.length} (${holds.map(([id, h]) => `${id}:${h.status}`).join(', ')})`,
);
console.log(`attempt log entries: ${log.list().length}`);
console.log('CONSOLE PROOF COMPLETE');
