/**
 * The purchase loop end to end, minus the chain: a real seller app on an
 * ephemeral port, and an EngineClient whose transport is a fake that
 * records submissions and answers get_payment from them. Success must
 * deliver the resource; a contract panic must surface as a typed
 * StipendError and land in the attempt log as blocked.
 *
 * The seller app and the successful client share one fake engine, so the
 * seller's /pay verification sees the client's recorded submission, the
 * same way both would read the same contract on chain.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttemptLog, type AttemptRecord } from '../src/attempts.js';
import { createStipendClient } from '../src/client.js';
import { EngineClient, type EngineTransport } from '../src/engine.js';
import { StipendError } from '../src/errors.js';
import { createSellerApp } from '../src/seller.js';
import { generateEd25519Keypair } from '../src/signing.js';
import type { EngineQuote, PaymentRecord } from '../src/types.js';

const CONTRACT = 'engine.testnet';
const SELLER_ACCOUNT = 'seller.testnet';
const AGENT = 'agent-1';
const RESOURCE = 'data:test';
const PRICE = 1000000000000000000000n; // 0.001 NEAR

interface RecordedCall {
  method: string;
  args: Record<string, unknown>;
}

function fakeEngine(panicWith?: string): { engine: EngineClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const transport: EngineTransport = {
    async call(method, args) {
      calls.push({ method, args });
      if (panicWith) {
        throw new Error(
          `engine call ${method} failed: {"Failure":{"ActionError":{"kind":` +
            `{"FunctionCallError":{"ExecutionError":"Smart contract panicked: ${panicWith}"}}}}}`,
        );
      }
      return 'InFlight';
    },
    async view(method, args) {
      if (method !== 'get_payment') return null;
      const req = calls.find(
        (c) => c.method === 'request_payment' && c.args['payment_id'] === args['payment_id'],
      );
      if (!req) return null;
      const quote = req.args['quote'] as EngineQuote;
      const record: PaymentRecord = {
        agent: req.args['agent_id'] as string,
        recipient: quote.recipient,
        amount: quote.amount,
        day: 20000,
        status: 'Succeeded',
        quote_hash: 'aGFzaA==',
      };
      return record;
    },
  };
  const engine = new EngineClient({
    networkId: 'testnet',
    nodeUrl: 'http://127.0.0.1:0',
    contractId: CONTRACT,
    accountId: 'runner.testnet',
    privateKey: 'ed25519:unused-with-transport',
    transport,
  });
  return { engine, calls };
}

const shared = fakeEngine();

let server: Server;
let sellerUrl: string;
let okLogPath: string;
let blockedLogPath: string;

beforeAll(async () => {
  const sellerKeys = generateEd25519Keypair();
  const app = createSellerApp({
    engine: shared.engine,
    contractId: CONTRACT,
    sellerAccountId: SELLER_ACCOUNT,
    quotePrivateKeyBase64: sellerKeys.privateKeyBase64,
    priceTable: { [RESOURCE]: { amount: PRICE, asset: 'NEAR' } },
    deliver: () => ({ answer: 42 }),
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no ephemeral port');
  sellerUrl = `http://127.0.0.1:${addr.port}`;

  const dir = mkdtempSync(join(tmpdir(), 'stipend-attempts-'));
  okLogPath = join(dir, 'ok.json');
  blockedLogPath = join(dir, 'blocked.json');
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe('purchase flow', () => {
  it('settles through the engine and delivers the resource', async () => {
    const client = createStipendClient({
      engine: shared.engine,
      agentId: AGENT,
      sellerBaseUrl: sellerUrl,
      attemptLog: new AttemptLog(okLogPath),
    });

    const { receipt, delivery } = await client.purchase(RESOURCE);
    expect(receipt.status).toBe('Succeeded');
    expect(receipt.amount).toBe(PRICE.toString());
    expect(receipt.recipient).toBe(SELLER_ACCOUNT);
    expect(delivery).toEqual({ answer: 42 });

    const submitted = shared.calls.find((c) => c.method === 'request_payment');
    expect(submitted).toBeTruthy();
    const quote = submitted!.args['quote'] as EngineQuote;
    expect(quote.amount).toBe(PRICE.toString());
    expect(quote.recipient).toBe(SELLER_ACCOUNT);
    expect(submitted!.args['agent_id']).toBe(AGENT);
    expect(submitted!.args['grant']).toBeNull();

    const logged = JSON.parse(readFileSync(okLogPath, 'utf8')) as AttemptRecord[];
    expect(logged).toHaveLength(1);
    expect(logged[0]?.outcome).toBe('succeeded');
    expect(logged[0]?.agent).toBe(AGENT);
    expect(logged[0]?.amount).toBe(PRICE.toString());
    expect(logged[0]?.resource).toBe(RESOURCE);
  });

  it('turns a cap panic into a CAP StipendError and logs the block', async () => {
    const blocked = fakeEngine('per-payment cap exceeded');
    const client = createStipendClient({
      engine: blocked.engine,
      agentId: AGENT,
      sellerBaseUrl: sellerUrl,
      attemptLog: new AttemptLog(blockedLogPath),
    });

    const err = await client.purchase(RESOURCE).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StipendError);
    expect((err as StipendError).code).toBe('CAP');
    expect((err as StipendError).message).toContain('per-payment cap exceeded');

    const logged = JSON.parse(readFileSync(blockedLogPath, 'utf8')) as AttemptRecord[];
    expect(logged).toHaveLength(1);
    expect(logged[0]?.outcome).toBe('blocked');
    expect(logged[0]?.reason).toBe('CAP');
    expect(logged[0]?.resource).toBe(RESOURCE);
  });
});
