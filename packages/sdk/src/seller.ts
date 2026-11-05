/**
 * The seller side of Stipend: an Express app that prices resources and
 * delivers them only after the policy engine confirms payment.
 *
 *   GET  /vault-quote?resource=  a signed quote the engine accepts
 *   POST /pay {payment_id, quote_id}
 *        verifies the on chain payment (exists, Succeeded, paid to this
 *        seller, for the quoted price), then issues a delivery token
 *   GET  /deliver?paymentId=&token=
 *        returns the resource once; a token delivers exactly once
 *
 * The seller never trusts the buyer: delivery is gated on the payment
 * record in the engine, not on anything the agent claims.
 */
import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import type { EngineClient } from './engine.js';
import { quoteHash, signQuote } from './signing.js';
import type { EngineQuote } from './types.js';

export interface SellerPrice {
  /** yoctoNEAR */
  amount: bigint;
  asset: 'NEAR';
}

export interface SellerOptions {
  engine: EngineClient;
  /** The policy engine contract id (quotes are bound to it). */
  contractId: string;
  /** This seller's NEAR account: quote recipient and payment destination. */
  sellerAccountId: string;
  /** base64 seed of the key registered in agents' allowlists. */
  quotePrivateKeyBase64: string;
  priceTable: Record<string, SellerPrice>;
  /** Produce the resource content for a paid delivery. */
  deliver: (resource: string) => unknown;
}

/** Whole second nanosecond timestamp (exact as a JSON number). */
function expiryNs(offsetSec: number): bigint {
  return (BigInt(Math.floor(Date.now() / 1000)) + BigInt(offsetSec)) * 1_000_000_000n;
}

export function createSellerApp(opts: SellerOptions): ReturnType<typeof express> {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  const quotes = new Map<string, { quote: EngineQuote; resource: string; paid: boolean }>();
  const deliveryTokens = new Map<string, { resource: string; used: boolean }>();

  app.get('/vault-quote', (req, res) => {
    const resource = String(req.query['resource'] ?? '');
    const price = opts.priceTable[resource];
    if (!price) {
      res.status(404).json({ error: `unknown resource: ${resource}` });
      return;
    }
    const termsHash = createHash('sha256')
      .update(`stipend|${opts.contractId}|${resource}|${price.amount.toString()}`, 'utf8')
      .digest();
    const quote = signQuote(
      opts.contractId,
      {
        recipient: opts.sellerAccountId,
        amount: price.amount,
        termsHash,
        expiryNs: expiryNs(300),
        quoteId: `q_${randomBytes(12).toString('hex')}`,
      },
      opts.quotePrivateKeyBase64,
    );
    quotes.set(quote.quote_id, { quote, resource, paid: false });
    res.json({ quote });
  });

  app.post('/pay', async (req, res) => {
    const body = req.body as { payment_id?: string; quote_id?: string };
    if (!body.payment_id || !body.quote_id) {
      res.status(400).json({ error: 'payment_id and quote_id are required' });
      return;
    }
    const stored = quotes.get(body.quote_id);
    if (!stored) {
      res.status(404).json({ error: 'unknown quote' });
      return;
    }
    if (stored.paid) {
      res.status(409).json({ error: 'quote already paid' });
      return;
    }
    let payment;
    try {
      payment = await opts.engine.getPayment(body.payment_id);
    } catch (e) {
      res.status(502).json({ error: `engine read failed: ${(e as Error).message}` });
      return;
    }
    if (!payment) {
      res.status(402).json({ error: 'payment not found in the engine' });
      return;
    }
    if (payment.status !== 'Succeeded') {
      res.status(402).json({ error: `payment status is ${payment.status}, not Succeeded` });
      return;
    }
    if (payment.recipient !== opts.sellerAccountId) {
      res.status(402).json({ error: 'payment recipient is not this seller' });
      return;
    }
    const price = opts.priceTable[stored.resource];
    if (!price || payment.amount !== price.amount.toString()) {
      res.status(402).json({ error: 'payment amount does not match the quoted price' });
      return;
    }
    // Bind the payment to this exact quote: the engine stores the hash
    // of the quote the payment was made under, and it must equal the
    // hash of the quote being claimed. Without this, a payment made for
    // one quote could claim any other quote at the same price.
    if (payment.quote_hash !== quoteHash(opts.contractId, stored.quote)) {
      res.status(402).json({ error: 'payment was not made for this quote' });
      return;
    }
    stored.paid = true;
    const deliveryToken = randomBytes(16).toString('hex');
    deliveryTokens.set(deliveryToken, { resource: stored.resource, used: false });
    res.json({ deliveryToken, quote_id: body.quote_id });
  });

  app.get('/deliver', (req, res) => {
    const token = String(req.query['token'] ?? '');
    const entry = deliveryTokens.get(token);
    if (!entry || entry.used) {
      res.status(403).json({ error: 'invalid or already used delivery token' });
      return;
    }
    entry.used = true;
    res.json({ resource: entry.resource, data: opts.deliver(entry.resource) });
  });

  return app;
}
