/**
 * The sample seller: prices two data resources and delivers them only
 * after the policy engine confirms payment. Run the agent against it with
 * `npm run agent`.
 *
 * The seller's engine client is only used for views (checking payment
 * records before delivery), so any signer works. It prefers the seller's
 * own key file when SELLER_KEY_PATH is set, and falls back to the agent
 * signer otherwise.
 */
import { EngineClient, createSellerApp, publicKeyFromSeed, type SellerPrice } from '@stipend/sdk';
import { loadConfig, readKeyJson, readSeed } from './config.js';

const NEAR = 10n ** 24n;

const priceTable: Record<string, SellerPrice> = {
  // 0.001 NEAR: inside the standard demo stipend, settles on its own.
  'data:market-report': { amount: NEAR / 1000n, asset: 'NEAR' },
  // 0.08 NEAR: above the standard 0.05 demo cap, so it lands in holds.
  'data:deep-dive': { amount: (NEAR * 8n) / 100n, asset: 'NEAR' },
};

function deliver(resource: string): unknown {
  if (resource === 'data:market-report') {
    return {
      resource,
      symbol: 'NEAR',
      headline: 'NEAR holds its range as agent activity grows',
      price_usd: 4.75,
      change_24h_pct: 2.3,
      volume_24h_usd: 182_000_000,
      generated_at: new Date().toISOString(),
    };
  }
  if (resource === 'data:deep-dive') {
    return {
      resource,
      symbol: 'NEAR',
      sections: [
        { title: 'Liquidity', body: 'Depth on major pairs is steady; slippage under 0.4% for 50k USD clips.' },
        { title: 'Agent flows', body: 'Intents volume from agent accounts rose for the third week running.' },
        { title: 'Risks', body: 'Thin weekend books and one concentrated market maker remain the watch items.' },
      ],
      verdict: 'Constructive, size with care.',
      generated_at: new Date().toISOString(),
    };
  }
  return { resource, note: 'sample payload' };
}

function main(): void {
  const cfg = loadConfig();
  if (!cfg.sellerAccountId) throw new Error('missing required env SELLER_ACCOUNT_ID');
  if (!cfg.sellerQuotePrivPath) throw new Error('missing required env SELLER_QUOTE_PRIV_PATH');
  const quoteSeed = readSeed(cfg.sellerQuotePrivPath);

  const signer = cfg.sellerKeyPath
    ? { accountId: cfg.sellerAccountId, keyPath: cfg.sellerKeyPath }
    : { accountId: cfg.agentAccountId, keyPath: cfg.agentKeyPath };
  if (!signer.keyPath) {
    throw new Error('set SELLER_KEY_PATH, or AGENT_ACCOUNT_ID and AGENT_KEY_PATH as the view signer');
  }
  const key = readKeyJson(signer.keyPath);
  const engine = new EngineClient({
    networkId: 'testnet',
    nodeUrl: cfg.rpcUrl,
    contractId: cfg.contractId,
    accountId: signer.accountId,
    privateKey: key.privateKey,
  });

  const app = createSellerApp({
    engine,
    contractId: cfg.contractId,
    sellerAccountId: cfg.sellerAccountId,
    quotePrivateKeyBase64: quoteSeed,
    priceTable,
    deliver,
  });

  app.listen(cfg.sellerPort, () => {
    console.log(`stipend seller on :${cfg.sellerPort}`);
    console.log(`seller account: ${cfg.sellerAccountId}`);
    console.log(
      `seller quote public key (put this in the agent allowlist): ${publicKeyFromSeed(quoteSeed)}`,
    );
    console.log(`resources: ${Object.keys(priceTable).join(', ')}`);
  });
}

main();
