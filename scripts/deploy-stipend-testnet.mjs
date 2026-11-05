// Deploy the Stipend engine onto stipend.testnet (created by Desmond via
// the testnet faucet with our deploy key as its full access key), init it
// as its own owner, and register the demo agent against the existing
// seller account. Run from the repo root: node scripts/deploy-stipend-testnet.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, keyStores, utils } from 'near-api-js';
import { EngineClient } from '../packages/sdk/dist/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RPC = 'https://rpc.testnet.near.org';
const ENGINE = 'stipend.testnet';
const info = JSON.parse(readFileSync(join(ROOT, 'keys/deploy-info.json'), 'utf8'));
const SELLER = info.seller;
const engineKey = JSON.parse(readFileSync(join(ROOT, 'keys', 'stipend.testnet.json'), 'utf8'));

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', ENGINE, utils.KeyPair.fromString(engineKey.private_key));
const near = await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore });
const account = await near.account(ENGINE);
const state = await account.state();
console.log(`stipend.testnet balance: ${state.amount} yocto, code: ${state.code_hash}`);

if (!state.code_hash || state.code_hash === '11111111111111111111111111111111') {
  const wasm = readFileSync(
    join(ROOT, 'contracts/policy-engine/target/wasm32-unknown-unknown/release/stipend_policy_engine.wasm'),
  );
  await account.deployContract(wasm);
  console.log(`engine wasm deployed (${wasm.length} bytes)`);
  await account.functionCall({
    contractId: ENGINE,
    methodName: 'new',
    args: { owner: ENGINE, approval_key: info.approvalPub },
    gas: '100000000000000',
  });
  console.log('engine initialized, owner is itself');
} else {
  console.log('engine already deployed, skipping deploy and init');
}

const client = new EngineClient({
  networkId: 'testnet',
  nodeUrl: RPC,
  contractId: ENGINE,
  accountId: ENGINE,
  privateKey: engineKey.private_key,
});
console.log(`engine owner: ${await client.getOwner()}`);
const existing = await client.getAgent('bot');
if (!existing) {
  await client.registerAgent({
    agentId: 'bot',
    perPaymentCap: '50000000000000000000000',
    dailyBudget: '1000000000000000000000000',
    authorizedCallers: [ENGINE],
    allowlist: [{ account: SELLER, quote_key: info.sellerQuotePub, label: 'Test data API' }],
  });
  console.log('agent bot registered: cap 0.05 NEAR, budget 1 NEAR/day');
} else {
  console.log('agent bot already registered');
}
const agent = await client.getAgent('bot');
console.log(`bot: status=${agent.status} policy_version=${agent.policy_version}`);

writeFileSync(
  join(ROOT, 'keys/deploy-info.json'),
  JSON.stringify({ ...info, engine: ENGINE, owner: ENGINE }, null, 2),
);
console.log('deploy-info.json updated: engine is stipend.testnet');
