// Console proof run: approve the held deep dive through the console API,
// then prove pause and revoke through the console endpoints, driving real
// purchases through the SDK agent client between each step.
// Run from the repo root, with the console on :8282 and the seller on :8787.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttemptLog, EngineClient, createStipendClient } from '../packages/sdk/dist/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'http://localhost:8282';
const SELLER = 'http://localhost:8787';
const info = JSON.parse(readFileSync(join(ROOT, 'keys/deploy-info.json'), 'utf8'));
const engineKey = JSON.parse(readFileSync(join(ROOT, 'keys', `${info.engine}.json`), 'utf8'));
const engine = new EngineClient({
  networkId: 'testnet',
  nodeUrl: info.rpc,
  contractId: info.engine,
  accountId: info.engine,
  privateKey: engineKey.private_key,
});
const agent = createStipendClient({
  engine,
  agentId: 'bot',
  sellerBaseUrl: SELLER,
  attemptLog: new AttemptLog(join(ROOT, 'data/attempts-stipend.json')),
});

const j = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
const post = (path, body) =>
  fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(j);

async function tryBuy(label) {
  try {
    const r = await agent.purchase('data:market-report');
    console.log(`${label}: purchase Succeeded (${r.receipt.payment_id ?? ''})`.trim());
    return 'ok';
  } catch (e) {
    console.log(`${label}: blocked [${e.code ?? '?'}]`);
    return e.code ?? 'error';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Holds: the deep dive attempt must be listed.
const holds = await j(await fetch(`${API}/api/holds`));
console.log(`holds listed: ${holds.body.length}`);
const hold = holds.body.find((h) => h.resource === 'data:deep-dive' && h.reason === 'CAP');
if (!hold) throw new Error('deep dive CAP hold not found in console');
console.log(`hold: ${hold.resource} amount=${hold.amount} reason=${hold.reason}`);

// 2. Approve it: the console signs a grant and the payment settles.
//    (Skipped when a settled deep dive payment already exists, so this
//    script can resume after a partial run.)
const prior = await j(await fetch(`${API}/api/payments`));
const already = prior.body.find(
  (p) => p.amount === hold.amount && p.status === 'Succeeded',
);
if (already) {
  console.log(`grant payment already settled: ${already.payment_id} (${already.amount} yocto)`);
} else {
  const approved = await post('/api/holds/approve', {
    agent: hold.agent,
    resource: hold.resource,
    sellerUrl: hold.sellerUrl,
    amount: hold.amount,
  });
  console.log(`approve response: HTTP ${approved.status}`);
  if (approved.status !== 200) throw new Error(`approve failed: ${JSON.stringify(approved.body)}`);
  const grantPaymentId = approved.body.payment_id;
  console.log(`grant payment submitted: ${grantPaymentId}`);
  for (let i = 0; i < 30; i++) {
    const p = await engine.getPayment(grantPaymentId);
    if (p && p.status === 'Succeeded') {
      console.log(`grant payment Succeeded: ${p.amount} yocto to ${p.recipient}`);
      break;
    }
    if (p && p.status === 'Failed') throw new Error('grant payment finalized as Failed');
    if (i === 29) throw new Error('grant payment did not finalize in time');
    await sleep(3000);
  }
}

// 3. Pause: purchases must fail PAUSED, then resume must restore them.
await post('/api/pause', { paused: true });
const pausedCode = await tryBuy('while paused');
await post('/api/pause', { paused: false });
if (pausedCode !== 'PAUSED') throw new Error(`expected PAUSED while paused, got ${pausedCode}`);

// 4. Revoke: purchases must fail REVOKED, then reactivate restores them.
await post('/api/agents/bot/revoke');
const revokedCode = await tryBuy('while revoked');
await post('/api/agents/bot/reactivate');
if (revokedCode !== 'REVOKED') throw new Error(`expected REVOKED while revoked, got ${revokedCode}`);
const restored = await tryBuy('after reactivate');
if (restored !== 'ok') throw new Error('purchase did not recover after reactivate');

// 5. Final state through the console API.
const stipends = await j(await fetch(`${API}/api/stipends`));
const bot = stipends.body.find((s) => s.agent_id === 'bot');
console.log(`bot spent_today: ${bot.spent_today} yocto, status: ${bot.status}`);
const payments = await j(await fetch(`${API}/api/payments`));
const succeeded = payments.body.filter((p) => p.status === 'Succeeded').length;
console.log(`payments listed: ${payments.body.length}, succeeded: ${succeeded}`);
console.log('CONSOLE PROOF COMPLETE');
