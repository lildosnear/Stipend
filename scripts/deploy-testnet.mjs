// Stipend testnet deploy: creates the engine and seller accounts under the
// funded payer account, deploys the policy engine wasm, initializes it
// (the engine account is its own owner), and registers the demo agent.
// Rerun safe: existing accounts and key files are reused.
//
// Run from the repo root: node scripts/deploy-testnet.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, keyStores, utils } from 'near-api-js';
import { EngineClient, generateEd25519Keypair } from '../packages/sdk/dist/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEYS = join(ROOT, 'keys');
const RPC = 'https://rpc.testnet.near.org';
const WASM = join(
  ROOT,
  'contracts/policy-engine/target/wasm32-unknown-unknown/release/stipend_policy_engine.wasm',
);
const PAYER_KEY_PATH =
  process.env['STIPEND_PAYER_KEY_PATH'] ?? join(process.env['HOME'], '.nyx-keys/payer.testnet.json');

const NEAR = (n) => BigInt(Math.round(n * 1e24)).toString();

async function accountExists(id) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'q',
      method: 'query',
      params: { request_type: 'view_account', finality: 'final', account_id: id },
    }),
  });
  const j = await r.json();
  return Boolean(j.result);
}

function loadOrCreateKeyPair(file) {
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return { keyPair: utils.KeyPair.fromString(parsed.private_key), fresh: false };
  }
  return { keyPair: utils.KeyPair.fromRandom('ed25519'), fresh: true };
}

function saveKeyFile(file, accountId, keyPair) {
  writeFileSync(
    file,
    JSON.stringify(
      {
        account_id: accountId,
        public_key: keyPair.getPublicKey().toString(),
        private_key: keyPair.toString(),
      },
      null,
      2,
    ),
  );
}

async function main() {
  mkdirSync(KEYS, { recursive: true });
  const payerKey = JSON.parse(readFileSync(PAYER_KEY_PATH, 'utf8'));
  const PAYER = payerKey.account_id;
  const ENGINE = `stipend.${PAYER}`;
  const SELLER = `seller.${PAYER}`;
  console.log(`payer ${PAYER}\nengine ${ENGINE}\nseller ${SELLER}`);

  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey('testnet', PAYER, utils.KeyPair.fromString(payerKey.private_key));
  const near = await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore });
  const payer = await near.account(PAYER);
  const state = await payer.state();
  console.log(`payer balance: ${state.amount} yocto`);
  if (BigInt(state.amount) < BigInt(NEAR(7))) throw new Error('payer balance too low to fund deploy');

  // --- engine account -------------------------------------------------------
  const engineKeyFile = join(KEYS, `${ENGINE}.json`);
  const engineKeys = loadOrCreateKeyPair(engineKeyFile);
  if (!(await accountExists(ENGINE))) {
    await payer.createAccount(ENGINE, engineKeys.keyPair.getPublicKey(), NEAR(6));
    console.log('engine account created with 6 NEAR');
  } else {
    console.log('engine account already exists, reusing');
  }
  if (engineKeys.fresh) saveKeyFile(engineKeyFile, ENGINE, engineKeys.keyPair);
  await keyStore.setKey('testnet', ENGINE, engineKeys.keyPair);
  const engine = await near.account(ENGINE);

  // --- seller account -------------------------------------------------------
  const sellerKeyFile = join(KEYS, `${SELLER}.json`);
  const sellerKeys = loadOrCreateKeyPair(sellerKeyFile);
  if (!(await accountExists(SELLER))) {
    await payer.createAccount(SELLER, sellerKeys.keyPair.getPublicKey(), NEAR(0.5));
    console.log('seller account created with 0.5 NEAR');
  } else {
    console.log('seller account already exists, reusing');
  }
  if (sellerKeys.fresh) saveKeyFile(sellerKeyFile, SELLER, sellerKeys.keyPair);
  await keyStore.setKey('testnet', SELLER, sellerKeys.keyPair);

  // --- off chain keys (approval + seller quote) ------------------------------
  const approvalFile = join(KEYS, 'stipend-approval.priv.b64');
  const approval = existsSync(approvalFile)
    ? null
    : generateEd25519Keypair();
  if (approval) writeFileSync(approvalFile, approval.privateKeyBase64 + '\n');
  const approvalPub = approval
    ? approval.publicKeyBase64
    : JSON.parse(readFileSync(join(KEYS, 'deploy-info.json'), 'utf8')).approvalPub;
  const quoteFile = join(KEYS, 'stipend-seller-quote.priv.b64');
  const quoteKeys = existsSync(quoteFile) ? null : generateEd25519Keypair();
  if (quoteKeys) writeFileSync(quoteFile, quoteKeys.privateKeyBase64 + '\n');
  const quotePub = quoteKeys
    ? quoteKeys.publicKeyBase64
    : JSON.parse(readFileSync(join(KEYS, 'deploy-info.json'), 'utf8')).sellerQuotePub;

  // --- deploy + init ----------------------------------------------------------
  const engineState = await engine.state();
  if (!engineState.code_hash || engineState.code_hash === '11111111111111111111111111111111') {
    const wasm = readFileSync(WASM);
    await engine.deployContract(wasm);
    console.log(`engine wasm deployed (${wasm.length} bytes)`);
    await engine.functionCall({
      contractId: ENGINE,
      methodName: 'new',
      args: { owner: ENGINE, approval_key: approvalPub },
      gas: '100000000000000',
    });
    console.log('engine initialized, owner is itself');
  } else {
    console.log('engine already has code, skipping deploy and init');
  }

  // --- register the demo agent --------------------------------------------------
  const client = new EngineClient({
    networkId: 'testnet',
    nodeUrl: RPC,
    contractId: ENGINE,
    accountId: ENGINE,
    privateKey: engineKeys.keyPair.toString(),
  });
  const owner = await client.getOwner();
  console.log(`engine owner: ${owner}`);
  const existing = await client.getAgent('bot');
  if (!existing) {
    await client.registerAgent({
      agentId: 'bot',
      perPaymentCap: '50000000000000000000000', // 0.05 NEAR
      dailyBudget: '1000000000000000000000000', // 1 NEAR
      authorizedCallers: [ENGINE],
      allowlist: [{ account: SELLER, quote_key: quotePub, label: 'Test data API' }],
    });
    console.log('agent bot registered: cap 0.05 NEAR, budget 1 NEAR/day');
  } else {
    console.log('agent bot already registered');
  }
  const agent = await client.getAgent('bot');
  console.log(`bot: status=${agent.status} policy_version=${agent.policy_version}`);

  writeFileSync(
    join(KEYS, 'deploy-info.json'),
    JSON.stringify(
      {
        engine: ENGINE,
        seller: SELLER,
        owner: ENGINE,
        agentId: 'bot',
        approvalPub,
        sellerQuotePub: quotePub,
        rpc: RPC,
      },
      null,
      2,
    ),
  );
  console.log('deploy info written to keys/deploy-info.json');
}

main().catch((e) => {
  console.error(`deploy failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
