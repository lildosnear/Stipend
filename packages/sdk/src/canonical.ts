/**
 * Canonical signing payloads for the Stipend policy engine.
 *
 * These byte layouts are the contract: the Rust contract rebuilds them from
 * the submitted quote or grant and verifies the ed25519 signature over them.
 * Any drift here means every signature fails on chain, so the layout is
 * pinned by test vectors in the test suite.
 *
 *   field(b) = u32 little endian length prefix + raw bytes
 *   string fields use their UTF-8 bytes
 *
 * QUOTE: "STIPEND-QUOTE-v1" + field(vault) + field(recipient)
 *        + u128 LE(amount) + field(terms_hash raw 32 bytes)
 *        + u64 LE(expiry_ns) + field(quote_id)
 * GRANT: "STIPEND-GRANT-v1" + field(vault) + field(agent) + field(recipient)
 *        + u128 LE(amount_max) + field(merchant_key raw 32 bytes)
 *        + u64 LE(expiry_ns) + field(nonce) + u64 LE(policy_version)
 */
import type { UnsignedGrant, UnsignedQuote } from './types.js';

const text = new TextEncoder();

function field(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

function fieldStr(value: string): Uint8Array {
  return field(text.encode(value));
}

function u128Le(value: bigint | string): Uint8Array {
  let v = BigInt(value);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function u64Le(value: bigint | number): Uint8Array {
  let v = BigInt(value);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const QUOTE_TAG = text.encode('STIPEND-QUOTE-v1');
const GRANT_TAG = text.encode('STIPEND-GRANT-v1');

/** The exact bytes a vendor signs for a quote. */
export function quotePayload(vaultId: string, q: UnsignedQuote): Uint8Array {
  return concat([
    QUOTE_TAG,
    fieldStr(vaultId),
    fieldStr(q.recipient),
    u128Le(q.amount),
    field(q.termsHash),
    u64Le(q.expiryNs),
    fieldStr(q.quoteId),
  ]);
}

/** The exact bytes the owner's approval key signs for a grant. */
export function grantPayload(vaultId: string, g: UnsignedGrant): Uint8Array {
  return concat([
    GRANT_TAG,
    fieldStr(vaultId),
    fieldStr(g.agent),
    fieldStr(g.recipient),
    u128Le(g.amountMax),
    field(g.merchantKey),
    u64Le(g.expiryNs),
    fieldStr(g.nonce),
    u64Le(g.policyVersion),
  ]);
}
