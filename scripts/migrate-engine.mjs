// Deploy the current engine wasm onto an existing engine account and
// run its migrate() so pre queue state carries over. The account must
// sign for itself (migrate is #[private]).
//   ACCOUNT_ID=<engine account> KEY_PATH=<its NEAR CLI key file> \
//     node scripts/migrate-engine.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, keyStores, utils } from 'near-api-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RPC = 'https://rpc.testnet.near.org';
const ACCOUNT_ID = process.env['ACCOUNT_ID'];
const KEY_PATH = process.env['KEY_PATH'];
if (!ACCOUNT_ID || !KEY_PATH) throw new Error('ACCOUNT_ID and KEY_PATH are required');

const keyJson = JSON.parse(readFileSync(KEY_PATH, 'utf8'));
const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', ACCOUNT_ID, utils.KeyPair.fromString(keyJson.private_key));
const near = await connect({ networkId: 'testnet', nodeUrl: RPC, keyStore });
const account = await near.account(ACCOUNT_ID);

async function view(method, args = {}) {
  const res = await account.viewFunction({ contractId: ACCOUNT_ID, methodName: method, args });
  return res;
}

console.log(`before: owner=${await view('get_owner')} payments=${await view('get_payment_count')}`);
const wasm = readFileSync(
  join(ROOT, 'contracts/policy-engine/target/wasm32-unknown-unknown/release/stipend_policy_engine.wasm'),
);
await account.deployContract(wasm);
console.log(`new wasm deployed (${wasm.length} bytes)`);
await account.functionCall({
  contractId: ACCOUNT_ID,
  methodName: 'migrate',
  args: {},
  gas: '100000000000000',
});
console.log('migrate() complete');
console.log(
  `after: owner=${await view('get_owner')} payments=${await view('get_payment_count')} ` +
    `agents=${await view('get_agent_count')} holds=${await view('get_hold_count')}`,
);
const payments = await view('list_payments', { offset: 0, limit: 3 });
console.log(`first payments still readable: ${JSON.stringify(payments).slice(0, 160)}`);
