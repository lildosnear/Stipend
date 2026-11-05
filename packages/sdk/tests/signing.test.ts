/** ed25519 signing roundtrips for quotes and grants. */
import { describe, expect, it } from 'vitest';
import {
  generateEd25519Keypair,
  publicKeyFromSeed,
  signGrant,
  signQuote,
  verifyGrant,
  verifyQuote,
} from '../src/signing.js';

const VAULT = 'engine.testnet';
const EXPIRY_NS = 1800000000000000000n;

describe('signing', () => {
  it('derives the public key from a seed', () => {
    const keys = generateEd25519Keypair();
    expect(publicKeyFromSeed(keys.privateKeyBase64)).toBe(keys.publicKeyBase64);
  });

  it('signs a quote that verifies, and a tampered quote does not', () => {
    const keys = generateEd25519Keypair();
    const quote = signQuote(
      VAULT,
      {
        recipient: 'seller.testnet',
        amount: 1000n,
        termsHash: Buffer.alloc(32, 0x01),
        expiryNs: EXPIRY_NS,
        quoteId: 'q_1',
      },
      keys.privateKeyBase64,
    );
    expect(quote.amount).toBe('1000');
    expect(quote.expiry_ns).toBe(1800000000000000000);
    expect(verifyQuote(VAULT, quote, keys.publicKeyBase64)).toBe(true);
    expect(verifyQuote(VAULT, { ...quote, amount: '1001' }, keys.publicKeyBase64)).toBe(false);
    expect(verifyQuote(VAULT, quote, generateEd25519Keypair().publicKeyBase64)).toBe(false);
  });

  it('signs a grant that verifies, and a tampered grant does not', () => {
    const approval = generateEd25519Keypair();
    const merchant = generateEd25519Keypair();
    const grant = signGrant(
      VAULT,
      {
        agent: 'agent-1',
        recipient: 'seller.testnet',
        amountMax: 2000n,
        merchantKey: Buffer.from(merchant.publicKeyBase64, 'base64'),
        expiryNs: EXPIRY_NS,
        nonce: 'n_1',
        policyVersion: 3,
      },
      approval.privateKeyBase64,
    );
    expect(grant.amount_max).toBe('2000');
    expect(grant.merchant_key).toBe(merchant.publicKeyBase64);
    expect(verifyGrant(VAULT, grant, approval.publicKeyBase64)).toBe(true);
    expect(verifyGrant(VAULT, { ...grant, policy_version: 4 }, approval.publicKeyBase64)).toBe(
      false,
    );
  });
});
