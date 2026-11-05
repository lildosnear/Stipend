/**
 * Owner tools: set stipends, approve held payments, pause and revoke.
 *
 * Approving a payment means signing a one time exception grant with the
 * owner's approval key and submitting the payment again with it. The grant
 * is bound to the agent, the vendor, the amount, the vendor's quote key
 * and the agent's current policy version, so it cannot be reused for a
 * different payment or after the policy changes.
 */
import { randomBytes } from 'node:crypto';
import type { EngineClient } from './engine.js';
import { signGrant } from './signing.js';
import type { AllowlistEntry, EngineQuote, HoldRecord, PaymentRecord } from './types.js';

export interface OwnerToolsOptions {
  engine: EngineClient;
  /** The policy engine contract id (grants are bound to it). */
  contractId: string;
  /** base64 seed of the approval key registered in the engine. */
  approvalPrivateKeyBase64: string;
}

export interface SetStipendParams {
  agentId: string;
  perPaymentCap: string;
  dailyBudget: string;
  authorizedCallers: string[];
  allowlist: AllowlistEntry[];
}

export interface ApprovePaymentParams {
  agentId: string;
  paymentId: string;
  quote: EngineQuote;
  /** Vendor quote key (base64). Defaults to the allowlist entry for the quote's recipient. */
  merchantKey?: string;
}

/** Whole second nanosecond timestamp (exact as a JSON number). */
function expiryNs(offsetSec: number): bigint {
  return (BigInt(Math.floor(Date.now() / 1000)) + BigInt(offsetSec)) * 1_000_000_000n;
}

export function createOwnerTools(opts: OwnerToolsOptions) {
  const { engine } = opts;
  return {
    /** Open (or register) a stipend for an agent. */
    setStipend(params: SetStipendParams): Promise<void> {
      return engine.registerAgent(params);
    },

    /** Approve one held payment with a signed grant and settle it. */
    async approvePayment(params: ApprovePaymentParams): Promise<PaymentRecord> {
      const agent = await engine.getAgent(params.agentId);
      if (!agent) throw new Error(`approvePayment: unknown agent "${params.agentId}"`);
      let merchantKey = params.merchantKey;
      if (!merchantKey) {
        merchantKey = agent.allowlist.find((e) => e.account === params.quote.recipient)?.quote_key;
      }
      if (!merchantKey) {
        throw new Error(
          `approvePayment: no merchant key for ${params.quote.recipient}; ` +
            'pass merchantKey or allowlist the vendor first',
        );
      }
      const grant = signGrant(
        opts.contractId,
        {
          agent: params.agentId,
          recipient: params.quote.recipient,
          amountMax: params.quote.amount,
          merchantKey: Buffer.from(merchantKey, 'base64'),
          expiryNs: expiryNs(600),
          nonce: `n_${randomBytes(12).toString('hex')}`,
          policyVersion: agent.policy_version,
        },
        opts.approvalPrivateKeyBase64,
      );
      const status = await engine.requestPayment(
        params.agentId,
        params.paymentId,
        params.quote,
        grant,
      );
      if (status !== 'InFlight') {
        const existing = await engine.getPayment(params.paymentId);
        if (existing) return existing;
      }
      return engine.pollPayment(params.paymentId);
    },

    // ----- the on chain hold queue ---------------------------------------

    /** The engine's approval queue, read from chain. */
    listHolds(offset = 0, limit = 50): Promise<[string, HoldRecord][]> {
      return engine.listHolds(offset, limit);
    },

    /**
     * Approve an on chain hold and execute it: the decision and the
     * settlement are separate on chain steps, run here in sequence.
     * Returns the settled payment record.
     */
    async approveHold(holdId: string): Promise<PaymentRecord> {
      await engine.approveHold(holdId);
      const paymentId = `pay_${randomBytes(12).toString('hex')}`;
      const status = await engine.executeHold(holdId, paymentId);
      if (status !== 'InFlight') {
        const existing = await engine.getPayment(paymentId);
        if (existing) return existing;
      }
      return engine.pollPayment(paymentId);
    },

    /** Reject an on chain hold. Terminal. */
    rejectHold(holdId: string): Promise<string> {
      return engine.rejectHold(holdId);
    },

    /** Pause every payment. */
    pauseAll(): Promise<void> {
      return engine.setPausedAll(true);
    },

    /** Lift the global pause. */
    resumeAll(): Promise<void> {
      return engine.setPausedAll(false);
    },

    /** Pause or resume the exception (grant) path only. */
    setExceptionsPaused(paused: boolean): Promise<void> {
      return engine.setPausedExceptions(paused);
    },

    /** Revoke an agent: no further payments are accepted for it. */
    revoke(agentId: string): Promise<void> {
      return engine.revokeAgent(agentId);
    },

    /** Bring a revoked agent back. Spent counters are preserved. */
    reactivate(agentId: string): Promise<void> {
      return engine.reactivateAgent(agentId);
    },
  };
}

export type OwnerTools = ReturnType<typeof createOwnerTools>;
