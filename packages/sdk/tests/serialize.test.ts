/**
 * serializeArgs: the contract takes raw u128 from JSON numbers, so digit
 * strings under the u128 keys must come out unquoted with their exact
 * digits, and everything else (including all-digit nonces and ids) must
 * stay a string.
 */
import { describe, expect, it } from 'vitest';
import { serializeArgs } from '../src/engine.js';

describe('serializeArgs', () => {
  it('emits register caps and budgets as raw numbers', () => {
    const json = serializeArgs({
      agent_id: 'bot',
      per_payment_cap: '50000000000000000000000',
      daily_budget: '1000000000000000000000000',
      authorized_callers: ['owner.testnet'],
      allowlist: [],
    }).toString('utf8');
    expect(json).toContain('"per_payment_cap":50000000000000000000000');
    expect(json).toContain('"daily_budget":1000000000000000000000000');
    expect(json).toContain('"agent_id":"bot"');
  });

  it('converts nested quote and grant amounts, keeps digit nonces quoted', () => {
    const json = serializeArgs({
      agent_id: 'bot',
      payment_id: 'pay_1',
      quote: {
        recipient: 'seller.testnet',
        amount: '1000000000000000000000',
        terms_hash: 'abc=',
        expiry_ns: 1800000000000000000,
        quote_id: 'q_1',
        signature: 'sig=',
      },
      grant: {
        agent: 'bot',
        recipient: 'seller.testnet',
        amount_max: '2000000000000000000000',
        merchant_key: 'key=',
        expiry_ns: 1800000000000000000,
        nonce: '12345',
        policy_version: 3,
        signature: 'sig=',
      },
    }).toString('utf8');
    expect(json).toContain('"amount":1000000000000000000000');
    expect(json).toContain('"amount_max":2000000000000000000000');
    expect(json).toContain('"nonce":"12345"');
    expect(json).toContain('"quote_id":"q_1"');
    expect(json).toContain('"expiry_ns":1800000000000000000');
  });

  it('leaves nulls alone (grant is null on the plain payment path)', () => {
    const json = serializeArgs({
      agent_id: 'bot',
      payment_id: 'pay_1',
      quote: null,
      grant: null,
    }).toString('utf8');
    expect(json).toContain('"grant":null');
    expect(json).toContain('"quote":null');
  });
});
