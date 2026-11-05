/**
 * The agent side of Stipend: one call buys a priced resource through the
 * agent's stipend.
 *
 *   purchase(resource)
 *     -> GET  {seller}/vault-quote?resource=   vendor signed quote
 *     -> engine.requestPayment                 the engine checks the stipend
 *     -> poll until final                      on chain settlement
 *     -> POST {seller}/pay                     claim with the payment id
 *     -> GET  {seller}/deliver                 the resource itself
 *
 * A rejection from the engine becomes a StipendError whose code comes from
 * the contract panic (CAP, BUDGET, VENDOR, EXPIRED, REVOKED, PAUSED,
 * CALLER, SIGNATURE, CHAIN). Blocked and settled attempts are written to
 * the attempt log when one is configured: a panic leaves no trace on
 * chain, so the log is the only record of a blocked payment.
 */
import { randomBytes } from 'node:crypto';
import type { AttemptLog } from './attempts.js';
import type { EngineClient } from './engine.js';
import { StipendError, codeFromPanic } from './errors.js';
import type { EngineQuote, PaymentRecord } from './types.js';

export interface StipendClientOptions {
  engine: EngineClient;
  agentId: string;
  sellerBaseUrl: string;
  attemptLog?: AttemptLog;
}

export interface PurchaseResult {
  receipt: PaymentRecord;
  delivery: unknown;
}

export class StipendClient {
  constructor(private readonly opts: StipendClientOptions) {}

  async purchase(resource: string): Promise<PurchaseResult> {
    const base = this.opts.sellerBaseUrl.replace(/\/+$/, '');
    const { engine, agentId } = this.opts;

    const quoteRes = await fetch(`${base}/vault-quote?resource=${encodeURIComponent(resource)}`);
    if (!quoteRes.ok) {
      throw new StipendError('QUOTE', `seller quote request failed: HTTP ${quoteRes.status}`);
    }
    const { quote } = (await quoteRes.json()) as { quote: EngineQuote };

    const paymentId = `pay_${randomBytes(12).toString('hex')}`;

    const logAttempt = (outcome: 'blocked' | 'succeeded', reason?: string, holdId?: string): void => {
      this.opts.attemptLog?.append({
        ts: Date.now(),
        payment_id: paymentId,
        agent: agentId,
        recipient: quote.recipient,
        amount: quote.amount,
        outcome,
        ...(reason ? { reason } : {}),
        ...(holdId ? { hold_id: holdId } : {}),
        resource,
        sellerUrl: base,
      });
    };

    try {
      await engine.requestPayment(agentId, paymentId, quote, null);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const code = codeFromPanic(message);
      // A policy limit block (cap or budget) is a holdable event: file
      // it in the engine's on chain queue so the owner can decide on
      // chain, not just in this local log. The hold takes the payment
      // id as its id, so the two records line up.
      let holdId: string | undefined;
      if (code === 'CAP' || code === 'BUDGET') {
        try {
          await engine.requestHold(paymentId, agentId, quote);
          holdId = paymentId;
        } catch {
          // Filing is best effort; the block itself is the fact.
        }
      }
      logAttempt('blocked', code, holdId);
      const err = new StipendError(code, `payment blocked by the engine: ${message}`);
      err.holdId = holdId;
      throw err;
    }

    const record = await engine.pollPayment(paymentId);
    if (record.status !== 'Succeeded') {
      logAttempt('blocked', 'SETTLEMENT');
      throw new StipendError('SETTLEMENT', `payment ${paymentId} ended as ${record.status}`);
    }

    const payRes = await fetch(`${base}/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payment_id: paymentId, quote_id: quote.quote_id }),
    });
    if (!payRes.ok) {
      throw new StipendError('DELIVERY', `seller pay failed: HTTP ${payRes.status}`);
    }
    const { deliveryToken } = (await payRes.json()) as { deliveryToken: string };

    const deliverRes = await fetch(
      `${base}/deliver?paymentId=${encodeURIComponent(paymentId)}&token=${encodeURIComponent(deliveryToken)}`,
    );
    if (!deliverRes.ok) {
      throw new StipendError('DELIVERY', `seller deliver failed: HTTP ${deliverRes.status}`);
    }
    const delivered = (await deliverRes.json()) as { resource: string; data: unknown };

    logAttempt('succeeded');
    return { receipt: record, delivery: delivered.data };
  }
}

/** Create the agent side client. */
export function createStipendClient(opts: StipendClientOptions): StipendClient {
  return new StipendClient(opts);
}
