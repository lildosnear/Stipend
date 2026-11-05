// Redeploy the policy engine wasm onto the existing engine account.
// Code only: contract state, agents, payments and balance are preserved.
// Run from the repo root: node scripts/redeploy.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, keyStores, utils } from 'near-api-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RPC = 'https://rpc.testnet.near.org';
const info = JSON.parse(readFileSync(join(ROOT, 'keys/deploy-info.json'), 'utf8'));
const keyFile = JSON.parse(readFileSync(join(ROOT, 'keys', `${info.engine}.json`), 'utf8'));

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', info.engine, utils.KeyPair.fromString(keyFile.private_key));
const near = await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore });
const engine = await near.account(info.engine);
const wasm = readFileSync(
  join(ROOT, 'contracts/policy-engine/target/wasm32-unknown-unknown/release/stipend_policy_engine.wasm'),
);
await engine.deployContract(wasm);
console.log(`redeployed ${wasm.length} bytes onto ${info.engine}`);
