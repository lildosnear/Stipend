/**
 * EngineClient: talks to the Stipend policy engine contract on NEAR testnet.
 *
 * One argument rule matters more than any other: the contract declares caps,
 * budgets and amounts as raw u128, and near-sdk deserializes those from JSON
 * *numbers*, not strings. A quoted value panics on chain with "invalid
 * number". Yocto amounts are far beyond float precision, so serializeArgs
 * emits digit strings under the u128 keys as raw JSON numbers, exactly, via
 * a sentinel that is stripped after stringification. The mapping is key
 * based only: all-digit ids and nonces under other keys stay strings.
 */
import { connect, keyStores, utils } from 'near-api-js';
import { StipendError } from './errors.js';
import type {
  AllowlistEntry,
  EngineGrant,
  EngineQuote,
  HoldRecord,
  PaymentRecord,
  StipendAgent,
} from './types.js';

/** Test seam: replace chain access entirely. */
export interface EngineTransport {
  call(method: string, args: Record<string, unknown>): Promise<unknown>;
  view(method: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface EngineClientConfig {
  /** Must be 'testnet'. There is no mainnet path in version one. */
  networkId: 'testnet';
  nodeUrl: string;
  contractId: string;
  /** Account that signs transactions (agent runner or owner). */
  accountId: string;
  /** near-api-js private key string, e.g. ed25519:... */
  privateKey: string;
  /** When given, near-api-js is skipped entirely. */
  transport?: EngineTransport;
}

const DEFAULT_GAS = '100000000000000'; // 100 Tgas

const RAW_NUMBER_KEYS = new Set(['per_payment_cap', 'daily_budget', 'amount', 'amount_max']);
const NUM_SENTINEL = '__STIPEND_RAWNUM__:';

/** JSON bytes for a contract call, with u128 digit strings emitted raw. */
export function serializeArgs(args: Record<string, unknown>): Buffer {
  const walk = (value: unknown, key?: string): unknown => {
    if (
      typeof value === 'string' &&
      key !== undefined &&
      RAW_NUMBER_KEYS.has(key) &&
      /^\d+$/.test(value)
    ) {
      return `${NUM_SENTINEL}${value}`;
    }
    if (Array.isArray(value)) return value.map((v) => walk(v));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v, k)]),
      );
    }
    return value;
  };
  const json = JSON.stringify(walk(args)).replace(/"__STIPEND_RAWNUM__:(\d+)"/g, '$1');
  return Buffer.from(json);
}

/**
 * The failure JSON of a panicked function call, or null. A panic surfaces on
 * the final outcome status; the transaction outcome only tracks conversion
 * to a receipt, so both are checked.
 */
export function txFailed(outcome: unknown): string | null {
  const o = outcome as {
    status?: unknown;
    transaction_outcome?: { outcome?: { status?: unknown } };
  } | null;
  for (const status of [o?.status, o?.transaction_outcome?.outcome?.status]) {
    if (status && typeof status === 'object' && 'Failure' in (status as object)) {
      return JSON.stringify(status);
    }
  }
  return null;
}

type NearConnection = Awaited<ReturnType<typeof connect>>;
type NearAccount = Awaited<ReturnType<NearConnection['account']>>;

class NearTransport implements EngineTransport {
  private accountPromise: Promise<NearAccount> | null = null;

  constructor(private readonly cfg: EngineClientConfig) {}

  private account(): Promise<NearAccount> {
    if (!this.accountPromise) {
      this.accountPromise = (async () => {
        const keyStore = new keyStores.InMemoryKeyStore();
        const keyPair = utils.KeyPair.fromString(this.cfg.privateKey as never);
        await keyStore.setKey(this.cfg.networkId, this.cfg.accountId, keyPair);
        const near = await connect({
          networkId: this.cfg.networkId,
          nodeUrl: this.cfg.nodeUrl,
          keyStore,
          // near-api-js v5 types omit base fields on ConnectConfig in this
          // toolchain; the runtime accepts them. Contained cast, as elsewhere.
        } as never);
        return near.account(this.cfg.accountId);
      })();
    }
    return this.accountPromise;
  }

  async call(method: string, args: Record<string, unknown>): Promise<unknown> {
    const account = await this.account();
    const outcome = await account.functionCall({
      contractId: this.cfg.contractId,
      methodName: method,
      // Raw JSON bytes: u128 fields must reach the contract as numbers
      // (see serializeArgs). The runtime accepts Buffer args even though
      // this toolchain's types only declare records. Contained cast.
      args: serializeArgs(args) as never,
      gas: BigInt(DEFAULT_GAS),
      attachedDeposit: 0n,
    });
    const failure = txFailed(outcome);
    if (failure) throw new Error(`engine call ${method} failed: ${failure}`);
    const status = (outcome as { status?: { SuccessValue?: string } }).status;
    if (status && typeof status === 'object' && 'SuccessValue' in status && status.SuccessValue) {
      const raw = Buffer.from(status.SuccessValue, 'base64').toString('utf8');
      return raw ? (JSON.parse(raw) as unknown) : null;
    }
    return null;
  }

  async view(method: string, args: Record<string, unknown>): Promise<unknown> {
    const account = await this.account();
    return account.viewFunction({
      contractId: this.cfg.contractId,
      methodName: method,
      args,
    });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Expand a value from a chain view to an exact decimal string. u128 fields
 * cross JSON as numbers, so view results hand back JS numbers whose
 * String() form is exponent notation ("1e+21") — useless for comparisons
 * or display. Expanding through BigInt recovers the full digits for every
 * value a double holds exactly, which covers realistic prices (0.001 NEAR,
 * 0.08 NEAR and similar round yocto amounts are all exact doubles).
 * (A double cannot hold every u128 exactly; digits beyond its precision
 * were already rounded by the JSON parser before reaching us. That dust
 * is far below a micro NEAR and only touches display of very large caps
 * or totals — the contract itself always compares true u128 values.)
 */
export function decimalString(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? BigInt(value).toString() : String(value);
  }
  return String(value);
}

function normalizePayment(payment: PaymentRecord): PaymentRecord {
  return { ...payment, amount: decimalString(payment.amount) };
}

function normalizeAgent(agent: StipendAgent): StipendAgent {
  return {
    ...agent,
    per_payment_cap: decimalString(agent.per_payment_cap),
    daily_budget: decimalString(agent.daily_budget),
  };
}

function normalizeHold(hold: HoldRecord): HoldRecord {
  return { ...hold, amount: decimalString(hold.amount) };
}

export class EngineClient {
  readonly contractId: string;
  private readonly transport: EngineTransport;

  constructor(private readonly cfg: EngineClientConfig) {
    if (cfg.networkId !== 'testnet') {
      throw new Error(
        `engine client: refusing networkId "${cfg.networkId as string}" — testnet only.`,
      );
    }
    this.contractId = cfg.contractId;
    this.transport = cfg.transport ?? new NearTransport(cfg);
  }

  // ----- agent payment path -------------------------------------------------

  /** Submit a payment request. Returns the immediate status (InFlight). */
  async requestPayment(
    agentId: string,
    paymentId: string,
    quote: EngineQuote,
    grant: EngineGrant | null = null,
  ): Promise<string> {
    const res = await this.transport.call('request_payment', {
      agent_id: agentId,
      payment_id: paymentId,
      quote,
      grant,
    });
    return res as string;
  }

  async getPayment(paymentId: string): Promise<PaymentRecord | null> {
    const payment = (await this.transport.view('get_payment', {
      payment_id: paymentId,
    })) as PaymentRecord | null;
    return payment ? normalizePayment(payment) : null;
  }

  // ----- the on chain hold queue -------------------------------------------

  /**
   * File a policy blocked payment as an on chain hold for the owner.
   * The hold id doubles as the attempted payment's id for traceability.
   * Returns the hold status (PendingApproval for a fresh hold).
   */
  async requestHold(holdId: string, agentId: string, quote: EngineQuote): Promise<string> {
    const res = await this.transport.call('request_hold', {
      hold_id: holdId,
      agent_id: agentId,
      quote,
    });
    return res as string;
  }

  async getHold(holdId: string): Promise<HoldRecord | null> {
    const hold = (await this.transport.view('get_hold', {
      hold_id: holdId,
    })) as HoldRecord | null;
    return hold ? normalizeHold(hold) : null;
  }

  async listHolds(offset = 0, limit = 50): Promise<[string, HoldRecord][]> {
    const rows = (await this.transport.view('list_holds', { offset, limit })) as [
      string,
      HoldRecord,
    ][];
    return rows.map(([id, hold]) => [id, normalizeHold(hold)]);
  }

  async getHoldCount(): Promise<number> {
    return (await this.transport.view('get_hold_count', {})) as number;
  }

  /** Owner decision on a hold. Execution is a separate step. */
  async approveHold(holdId: string): Promise<string> {
    return (await this.transport.call('approve_hold', { hold_id: holdId })) as string;
  }

  async rejectHold(holdId: string): Promise<string> {
    return (await this.transport.call('reject_hold', { hold_id: holdId })) as string;
  }

  async expireHold(holdId: string): Promise<string> {
    return (await this.transport.call('expire_hold', { hold_id: holdId })) as string;
  }

  /** Settle an approved hold under a fresh payment id. */
  async executeHold(holdId: string, paymentId: string): Promise<string> {
    return (await this.transport.call('execute_hold', {
      hold_id: holdId,
      payment_id: paymentId,
    })) as string;
  }

  /** Poll until the payment reaches a terminal status. */
  async pollPayment(
    paymentId: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<PaymentRecord> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const start = Date.now();
    for (;;) {
      const payment = await this.getPayment(paymentId);
      if (payment && (payment.status === 'Succeeded' || payment.status === 'Failed')) {
        return payment;
      }
      if (Date.now() - start > timeoutMs) {
        throw new StipendError(
          'SETTLEMENT',
          `payment ${paymentId} did not finalize within ${timeoutMs}ms`,
        );
      }
      await sleep(2000);
    }
  }

  /** Submit and wait for the final record (handles idempotent replays). */
  async payAndWait(
    agentId: string,
    paymentId: string,
    quote: EngineQuote,
    grant: EngineGrant | null = null,
  ): Promise<PaymentRecord> {
    const status = await this.requestPayment(agentId, paymentId, quote, grant);
    if (status !== 'InFlight') {
      const existing = await this.getPayment(paymentId);
      if (existing) return existing;
    }
    return this.pollPayment(paymentId);
  }

  // ----- views ----------------------------------------------------------------

  async getAgent(agentId: string): Promise<StipendAgent | null> {
    const agent = (await this.transport.view('get_agent', {
      agent_id: agentId,
    })) as StipendAgent | null;
    return agent ? normalizeAgent(agent) : null;
  }

  async listAgents(offset = 0, limit = 50): Promise<[string, StipendAgent][]> {
    const rows = (await this.transport.view('list_agents', { offset, limit })) as [
      string,
      StipendAgent,
    ][];
    return rows.map(([id, agent]) => [id, normalizeAgent(agent)] as [string, StipendAgent]);
  }

  async listPayments(offset = 0, limit = 50): Promise<[string, PaymentRecord][]> {
    const rows = (await this.transport.view('list_payments', { offset, limit })) as [
      string,
      PaymentRecord,
    ][];
    return rows.map(([id, payment]) => [id, normalizePayment(payment)] as [string, PaymentRecord]);
  }

  async getAgentCount(): Promise<number> {
    return (await this.transport.view('get_agent_count', {})) as number;
  }

  async getPaymentCount(): Promise<number> {
    return (await this.transport.view('get_payment_count', {})) as number;
  }

  async getSpent(agentId: string, day: number): Promise<string> {
    const value = await this.transport.view('get_spent', { agent_id: agentId, day });
    return decimalString(value);
  }

  /** Pause flags as [exceptions paused, all paused]. */
  async getPaused(): Promise<[boolean, boolean]> {
    return (await this.transport.view('get_paused', {})) as [boolean, boolean];
  }

  async getOwner(): Promise<string> {
    return (await this.transport.view('get_owner', {})) as string;
  }

  /** Yocto currently reserved by in flight payments, as a decimal string. */
  async getTotalInFlight(): Promise<string> {
    const value = await this.transport.view('get_total_in_flight', {});
    return decimalString(value);
  }

  // ----- owner administration -------------------------------------------------

  async registerAgent(params: {
    agentId: string;
    perPaymentCap: string;
    dailyBudget: string;
    authorizedCallers: string[];
    allowlist: AllowlistEntry[];
  }): Promise<void> {
    await this.transport.call('register_agent', {
      agent_id: params.agentId,
      per_payment_cap: params.perPaymentCap,
      daily_budget: params.dailyBudget,
      authorized_callers: params.authorizedCallers,
      allowlist: params.allowlist,
    });
  }

  async updateAgentPolicy(
    agentId: string,
    patch: { perPaymentCap?: string; dailyBudget?: string; authorizedCallers?: string[] },
  ): Promise<void> {
    await this.transport.call('update_agent_policy', {
      agent_id: agentId,
      per_payment_cap: patch.perPaymentCap ?? null,
      daily_budget: patch.dailyBudget ?? null,
      authorized_callers: patch.authorizedCallers ?? null,
    });
  }

  async setAllowlist(agentId: string, allowlist: AllowlistEntry[]): Promise<void> {
    await this.transport.call('set_allowlist', { agent_id: agentId, allowlist });
  }

  async revokeAgent(agentId: string, reason?: string): Promise<void> {
    await this.transport.call('revoke_agent', { agent_id: agentId, reason: reason ?? null });
  }

  async reactivateAgent(agentId: string, authorizedCallers?: string[]): Promise<void> {
    await this.transport.call('reactivate_agent', {
      agent_id: agentId,
      authorized_callers: authorizedCallers ?? null,
    });
  }

  async setApprovalKey(publicKeyBase64: string): Promise<void> {
    await this.transport.call('set_approval_key', { key: publicKeyBase64 });
  }

  async setPausedExceptions(paused: boolean): Promise<void> {
    await this.transport.call('set_paused_exceptions', { paused });
  }

  async setPausedAll(paused: boolean): Promise<void> {
    await this.transport.call('set_paused_all', { paused });
  }

  async recoverPayment(paymentId: string, succeeded: boolean, evidenceRef: string): Promise<void> {
    await this.transport.call('recover_payment', {
      payment_id: paymentId,
      succeeded,
      evidence_ref: evidenceRef,
    });
  }

  async withdraw(amountYocto: string): Promise<void> {
    await this.transport.call('withdraw', { amount: amountYocto });
  }
}
