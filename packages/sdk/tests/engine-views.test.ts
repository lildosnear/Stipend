/**
 * Small guarantees the apps rely on: the attempt log creates its own
 * folder (a fresh data/ directory must not crash a purchase), and the
 * engine client wraps every view the contract exposes.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AttemptLog, EngineClient } from '@stipend/sdk';

describe('AttemptLog folders', () => {
  it('creates nested folders on append', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stipend-attempts-'));
    const file = join(dir, 'deep', 'nested', 'attempts.json');
    const log = new AttemptLog(file);
    log.append({
      ts: 1,
      payment_id: 'pay_1',
      agent: 'bot',
      recipient: 'seller.testnet',
      amount: '1000',
      outcome: 'blocked',
      reason: 'CAP',
    });
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown[];
    expect(parsed).toHaveLength(1);
    expect(log.list()[0]?.payment_id).toBe('pay_1');
  });
});

describe('EngineClient u128 view normalization', () => {
  it('expands numeric amounts to full digit strings', async () => {
    const engine = new EngineClient({
      networkId: 'testnet',
      nodeUrl: 'http://localhost:0',
      contractId: 'engine.testnet',
      accountId: 'owner.testnet',
      privateKey: 'ed25519:unused',
      transport: {
        call: async () => null,
        view: async (method) => {
          // Views return u128 as JSON numbers, exactly as the chain does.
          if (method === 'get_payment')
            return {
              agent: 'bot',
              recipient: 'seller.testnet',
              amount: 1e21,
              day: 20762,
              status: 'Succeeded',
              quote_hash: 'x',
            };
          if (method === 'get_agent')
            return {
              status: 'Active',
              policy_version: 1,
              per_payment_cap: 8e22,
              daily_budget: 1e24,
              authorized_callers: [],
              allowlist: [],
            };
          if (method === 'get_spent') return 3e21;
          throw new Error(`unexpected view ${method}`);
        },
      },
    });
    const payment = await engine.getPayment('pay_1');
    expect(payment?.amount).toBe('1000000000000000000000');
    const agent = await engine.getAgent('bot');
    expect(agent?.per_payment_cap).toBe('80000000000000000000000');
    expect(await engine.getSpent('bot', 20762)).toBe('3000000000000000000000');
  });
});

describe('EngineClient remaining views', () => {
  it('reads owner and total in flight through the transport', async () => {
    const engine = new EngineClient({
      networkId: 'testnet',
      nodeUrl: 'http://localhost:0',
      contractId: 'engine.testnet',
      accountId: 'owner.testnet',
      privateKey: 'ed25519:unused',
      transport: {
        call: async () => null,
        view: async (method) => {
          if (method === 'get_owner') return 'owner.testnet';
          if (method === 'get_total_in_flight') return 12345;
          throw new Error(`unexpected view ${method}`);
        },
      },
    });
    expect(await engine.getOwner()).toBe('owner.testnet');
    expect(await engine.getTotalInFlight()).toBe('12345');
  });
});
