/**
 * ed25519 signing for quotes and grants, using node:crypto only.
 *
 * Keys travel as base64 of the raw bytes: a 32 byte seed for private keys,
 * a 32 byte raw public key, and 64 byte signatures. node:crypto wants
 * KeyObjects, so raw material is wrapped in the fixed DER prefixes for
 * ed25519 (PKCS8 for private keys, SPKI for public keys).
 */
import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { grantPayload, quotePayload } from './canonical.js';
import type { EngineGrant, EngineQuote, UnsignedGrant, UnsignedQuote } from './types.js';

/** DER PKCS8 prefix for an ed25519 private key holding a raw 32 byte seed. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
/** DER SPKI prefix for an ed25519 public key holding a raw 32 byte key. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function privateKeyFromSeed(seed: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

function rawPublicKeyFromSeed(seed: Buffer): Buffer {
  const der = createPublicKey(privateKeyFromSeed(seed)).export({
    format: 'der',
    type: 'spki',
  }) as Buffer;
  return der.subarray(der.length - 32);
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

function signPayload(payload: Uint8Array, privateKeyBase64: string): string {
  const seed = Buffer.from(privateKeyBase64, 'base64');
  return cryptoSign(null, payload, privateKeyFromSeed(seed)).toString('base64');
}

function verifyPayload(payload: Uint8Array, signatureBase64: string, publicKeyBase64: string): boolean {
  try {
    return cryptoVerify(
      null,
      payload,
      publicKeyFromRaw(Buffer.from(publicKeyBase64, 'base64')),
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
}

export interface Ed25519Keypair {
  /** base64 of the raw 32 byte public key */
  publicKeyBase64: string;
  /** base64 of the raw 32 byte seed */
  privateKeyBase64: string;
}

/** A fresh ed25519 keypair (random 32 byte seed). */
export function generateEd25519Keypair(): Ed25519Keypair {
  const seed = randomBytes(32);
  return {
    publicKeyBase64: rawPublicKeyFromSeed(seed).toString('base64'),
    privateKeyBase64: seed.toString('base64'),
  };
}

/** Derive the base64 raw public key for a base64 seed. */
export function publicKeyFromSeed(privateKeyBase64: string): string {
  return rawPublicKeyFromSeed(Buffer.from(privateKeyBase64, 'base64')).toString('base64');
}

/** Build a fully signed quote with a vendor's quote key. */
export function signQuote(
  vaultId: string,
  q: UnsignedQuote,
  merchantPrivateKeyBase64: string,
): EngineQuote {
  return {
    recipient: q.recipient,
    amount: BigInt(q.amount).toString(),
    terms_hash: q.termsHash.toString('base64'),
    expiry_ns: Number(q.expiryNs),
    quote_id: q.quoteId,
    signature: signPayload(quotePayload(vaultId, q), merchantPrivateKeyBase64),
  };
}

/** Verify a quote against a vendor public key (base64). */
export function verifyQuote(vaultId: string, quote: EngineQuote, merchantPublicKeyBase64: string): boolean {
  const payload = quotePayload(vaultId, {
    recipient: quote.recipient,
    amount: quote.amount,
    termsHash: Buffer.from(quote.terms_hash, 'base64'),
    expiryNs: quote.expiry_ns,
    quoteId: quote.quote_id,
  });
  return verifyPayload(payload, quote.signature, merchantPublicKeyBase64);
}

/** Build a fully signed exception grant with the owner's approval key. */
export function signGrant(
  vaultId: string,
  g: UnsignedGrant,
  approvalPrivateKeyBase64: string,
): EngineGrant {
  return {
    agent: g.agent,
    recipient: g.recipient,
    amount_max: BigInt(g.amountMax).toString(),
    merchant_key: g.merchantKey.toString('base64'),
    expiry_ns: Number(g.expiryNs),
    nonce: g.nonce,
    policy_version: g.policyVersion,
    signature: signPayload(grantPayload(vaultId, g), approvalPrivateKeyBase64),
  };
}

/** Verify a grant against the registered approval key (base64). */
export function verifyGrant(vaultId: string, grant: EngineGrant, approvalPublicKeyBase64: string): boolean {
  const payload = grantPayload(vaultId, {
    agent: grant.agent,
    recipient: grant.recipient,
    amountMax: grant.amount_max,
    merchantKey: Buffer.from(grant.merchant_key, 'base64'),
    expiryNs: grant.expiry_ns,
    nonce: grant.nonce,
    policyVersion: grant.policy_version,
  });
  return verifyPayload(payload, grant.signature, approvalPublicKeyBase64);
}
