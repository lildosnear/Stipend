/**
 * Canonical payload vectors. These hex strings are the byte for byte layout
 * the Rust contract rebuilds before verifying a signature. If they drift,
 * every quote and grant fails on chain.
 */
import { describe, expect, it } from 'vitest';
import { grantPayload, quotePayload } from '../src/canonical.js';

const QUOTE_PAYLOAD_HEX =
  '53544950454e442d51554f54452d76310e000000656e67696e652e746573746e65740e00000073656c6c65722e746573746e6574e80300000000000000000000000000002000000001010101010101010101010101010101010101010101010101010101010101010000b49376e2fa1808000000712d766563746f72';

const GRANT_PAYLOAD_HEX =
  '53544950454e442d4752414e542d76310e000000656e67696e652e746573746e6574070000006167656e742d310e00000073656c6c65722e746573746e6574d00700000000000000000000000000002000000002020202020202020202020202020202020202020202020202020202020202020000b49376e2fa18080000006e2d766563746f720300000000000000';

describe('canonical payloads', () => {
  it('quote payload matches the pinned vector', () => {
    const payload = quotePayload('engine.testnet', {
      recipient: 'seller.testnet',
      amount: 1000n,
      termsHash: Buffer.alloc(32, 0x01),
      expiryNs: 1800000000000000000n,
      quoteId: 'q-vector',
    });
    expect(Buffer.from(payload).toString('hex')).toBe(QUOTE_PAYLOAD_HEX);
  });

  it('grant payload matches the pinned vector', () => {
    const payload = grantPayload('engine.testnet', {
      agent: 'agent-1',
      recipient: 'seller.testnet',
      amountMax: 2000n,
      merchantKey: Buffer.alloc(32, 0x02),
      expiryNs: 1800000000000000000,
      nonce: 'n-vector',
      policyVersion: 3,
    });
    expect(Buffer.from(payload).toString('hex')).toBe(GRANT_PAYLOAD_HEX);
  });
});
