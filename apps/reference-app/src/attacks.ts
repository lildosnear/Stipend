/**
 * Attack scenes: hand built quotes submitted straight to the engine,
 * bypassing the honest seller flow. Each scene must be blocked by the
 * engine with the expected reason; the script prints PASS or FAIL per
 * scene and exits non-zero when any scene is not blocked as expected.
 *
 *   1. Expired quote      a real seller quote, signed correctly, but stale
 *   2. Forged quote       right recipient and price, signed with a wrong key
 *   3. Unknown vendor     a quote naming a recipient outside the allowlist
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  codeFromPanic,
  generateEd25519Keypair,
  signQuote,
  type EngineQuote,
} from '@stipend/sdk';
import { agentEngine, loadConfig, readSeed } from './config.js';

const MARKET_PRICE = (10n ** 24n) / 1000n; // 0.001 NEAR, data:market-report
const RESOURCE = 'data:market-report';

/** Terms hash exactly as the seller app computes it. */
function termsHash(contractId: string, resource: string, amount: bigint): Buffer {
  return createHash('sha256')
    .update(`stipend|${contractId}|${resource}|${amount.toString()}`, 'utf8')
    .digest();
}

/** Whole second nanosecond timestamp (exact as a JSON number). */
function expiryNs(offsetSec: number): bigint {
  return (BigInt(Math.floor(Date.now() / 1000)) + BigInt(offsetSec)) * 1_000_000_000n;
}

const pid = (prefix: string): string => `${prefix}_${randomBytes(6).toString('hex')}`;

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.sellerAccountId) throw new Error('missing required env SELLER_ACCOUNT_ID');
  if (!cfg.sellerQuotePrivPath) throw new Error('missing required env SELLER_QUOTE_PRIV_PATH');
  const sellerSeed = readSeed(cfg.sellerQuotePrivPath);
  const engine = agentEngine(cfg);

  const agent = await engine.getAgent(cfg.agentId);
  if (!agent) {
    console.error(
      `agent "${cfg.agentId}" is not registered in ${cfg.contractId}; set its stipend first`,
    );
    process.exit(1);
  }

  let failures = 0;
  const scene = async (
    name: string,
    quote: EngineQuote,
    wantCode: string,
    needles: string[],
  ): Promise<void> => {
    try {
      await engine.requestPayment(cfg.agentId, pid('atk'), quote, null);
      console.log(`FAIL  ${name}: the engine accepted the payment`);
      failures += 1;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const code = codeFromPanic(message);
      if (code === wantCode || needles.some((n) => message.includes(n))) {
        console.log(`PASS  ${name}: blocked [${code}]`);
      } else {
        console.log(`FAIL  ${name}: blocked with an unexpected error [${code}] ${message.slice(0, 200)}`);
        failures += 1;
      }
    }
  };

  const base = {
    amount: MARKET_PRICE,
    termsHash: termsHash(cfg.contractId, RESOURCE, MARKET_PRICE),
  };

  // 1. Expired quote: real seller key, expiry ten minutes in the past.
  await scene(
    'expired quote',
    signQuote(
      cfg.contractId,
      { ...base, recipient: cfg.sellerAccountId, expiryNs: expiryNs(-600), quoteId: pid('q_exp') },
      sellerSeed,
    ),
    'EXPIRED',
    ['quote expired'],
  );

  // 2. Forged quote: right recipient and price, signed with a fresh wrong key.
  const wrongKey = generateEd25519Keypair();
  await scene(
    'forged quote (wrong signing key)',
    signQuote(
      cfg.contractId,
      { ...base, recipient: cfg.sellerAccountId, expiryNs: expiryNs(300), quoteId: pid('q_forge') },
      wrongKey.privateKeyBase64,
    ),
    'SIGNATURE',
    ['bad quote signature'],
  );

  // 3. Unknown vendor: a recipient that is not in the agent's allowlist.
  await scene(
    'unknown vendor',
    signQuote(
      cfg.contractId,
      { ...base, recipient: 'stranger.testnet', expiryNs: expiryNs(300), quoteId: pid('q_stranger') },
      sellerSeed,
    ),
    'VENDOR',
    ['not allowlisted', 'unknown vendor'],
  );

  if (failures > 0) {
    console.log(`${failures} attack scene(s) were not blocked as expected`);
    process.exit(1);
  }
  console.log('all attack scenes blocked as expected');
}

main().catch((e: unknown) => {
  console.error(`attacks failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
