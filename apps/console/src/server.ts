/**
 * Stipend owner console: a small Express server over the policy engine,
 * mirroring what the SDK exposes. The owner sees stipends, payments, the
 * holds queue and the blocked attempts log, and can approve a held
 * payment, pause the engine, or revoke and reactivate an agent.
 *
 * Startup never touches the chain: clients are constructed from env and
 * connect lazily, so /health answers even when the engine is unreachable.
 * EngineClient covers most views; get_owner and get_total_in_flight are
 * read through raw RPC view calls because the SDK does not wrap them.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import {
  AttemptLog,
  EngineClient,
  createOwnerTools,
  type EngineQuote,
} from '@stipend/sdk';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ----- env and key helpers ---------------------------------------------------

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function required(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

/** Read a NEAR CLI key file ({account_id, private_key}). */
function readKeyJson(filePath: string): { accountId: string; privateKey: string } {
  if (!existsSync(filePath)) throw new Error(`key file not found: ${filePath}`);
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as {
    account_id?: string;
    private_key?: string;
    secret_key?: string;
  };
  const privateKey = parsed.private_key ?? parsed.secret_key;
  if (!parsed.account_id || !privateKey) {
    throw new Error(`key file ${filePath} is not NEAR CLI JSON ({account_id, private_key})`);
  }
  return { accountId: parsed.account_id, privateKey };
}

/** Read a base64 ed25519 seed file (.priv.b64), trimmed. */
function readSeed(filePath: string): string {
  if (!existsSync(filePath)) throw new Error(`seed file not found: ${filePath}`);
  return readFileSync(filePath, 'utf8').trim();
}

const CONTRACT_ID = required('STIPEND_CONTRACT_ID');
const OWNER_ACCOUNT_ID = required('STIPEND_OWNER_ACCOUNT_ID');
const OWNER_KEY_PATH = required('STIPEND_OWNER_KEY_PATH');
const APPROVAL_PRIV_PATH = required('STIPEND_APPROVAL_PRIV_PATH');
const RPC_URL = env('STIPEND_RPC_URL') ?? 'https://rpc.testnet.near.org';
const ATTEMPTS_PATH = env('STIPEND_ATTEMPTS_PATH')
  ? path.resolve(env('STIPEND_ATTEMPTS_PATH') as string)
  : path.resolve(APP_DIR, '../../data/attempts.json');
const PORT = Number(env('PORT') ?? '8282');

const ownerKey = readKeyJson(OWNER_KEY_PATH);
const engine = new EngineClient({
  networkId: 'testnet',
  nodeUrl: RPC_URL,
  contractId: CONTRACT_ID,
  accountId: OWNER_ACCOUNT_ID,
  privateKey: ownerKey.privateKey,
});
const owner = createOwnerTools({
  engine,
  contractId: CONTRACT_ID,
  approvalPrivateKeyBase64: readSeed(APPROVAL_PRIV_PATH),
});
const attempts = new AttemptLog(ATTEMPTS_PATH);

// ----- raw RPC views the SDK does not wrap -----------------------------------

async function rpcQuery(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'stipend-console', method: 'query', params }),
  });
  const body = (await res.json()) as {
    result?: Record<string, unknown>;
    error?: { message?: string; data?: string };
  };
  if (body.error || !body.result) {
    throw new Error(`rpc query failed: ${body.error?.data ?? body.error?.message ?? 'unknown error'}`);
  }
  return body.result;
}

/** Raw text of a call_function view result (bytes decoded as utf8). */
async function callViewText(method: string, args: Record<string, unknown>): Promise<string> {
  const result = await rpcQuery({
    request_type: 'call_function',
    account_id: CONTRACT_ID,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args), 'utf8').toString('base64'),
    finality: 'optimistic',
  });
  const bytes = result['result'] as number[];
  return Buffer.from(bytes).toString('utf8');
}

async function callViewJson(method: string, args: Record<string, unknown>): Promise<unknown> {
  const text = await callViewText(method, args);
  return text ? (JSON.parse(text) as unknown) : null;
}

/** A u128 view as an exact digit string (the raw JSON text already is one). */
async function callViewAmount(method: string): Promise<string | null> {
  const text = (await callViewText(method, {})).trim();
  if (/^\d+$/.test(text)) return text;
  const value: unknown = text ? JSON.parse(text) : null;
  return value === null || value === undefined ? null : String(value);
}

/** Engine account balance in yocto, or null when the account read fails. */
async function engineBalance(): Promise<string | null> {
  try {
    const result = await rpcQuery({
      request_type: 'view_account',
      account_id: CONTRACT_ID,
      finality: 'optimistic',
    });
    return typeof result['amount'] === 'string' ? result['amount'] : null;
  } catch {
    return null;
  }
}

/** Run a fallible read, yielding null instead of failing the whole page. */
async function attempt<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

const currentDay = (): number => Math.floor((Date.now() * 1e6) / 86_400_000_000_000);

// ----- app ---------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '256kb' }));

const fail = (res: Response, e: unknown): void => {
  res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
};
type Handler = (req: Request, res: Response) => Promise<void>;
const wrap =
  (fn: Handler): Handler =>
  async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      fail(res, e);
    }
  };

app.get('/health', (_req, res) => {
  res.json({ ok: true, contract: CONTRACT_ID });
});

app.get(
  '/api/overview',
  wrap(async (_req, res) => {
    const [ownerId, paused, totalInFlight, agentCount, paymentCount, balance] = await Promise.all([
      attempt(() => callViewJson('get_owner', {})),
      attempt(() => engine.getPaused()),
      attempt(() => callViewAmount('get_total_in_flight')),
      attempt(() => engine.getAgentCount()),
      attempt(() => engine.getPaymentCount()),
      engineBalance(),
    ]);
    res.json({
      owner: ownerId,
      paused,
      totalInFlight,
      agentCount,
      paymentCount,
      engineBalance: balance,
    });
  }),
);

app.get(
  '/api/stipends',
  wrap(async (_req, res) => {
    const day = currentDay();
    const entries = await engine.listAgents(0, 100);
    const rows = await Promise.all(
      entries.map(async ([agentId, a]) => ({
        agent_id: agentId,
        status: a.status,
        per_payment_cap: a.per_payment_cap,
        daily_budget: a.daily_budget,
        authorized_callers: a.authorized_callers,
        allowlist: a.allowlist,
        policy_version: a.policy_version,
        spent_today: await attempt(() => engine.getSpent(agentId, day)),
      })),
    );
    res.json(rows);
  }),
);

app.get(
  '/api/payments',
  wrap(async (_req, res) => {
    const entries = await engine.listPayments(0, 200);
    const rows = entries
      .slice()
      .reverse()
      .map(([paymentId, p]) => ({
        payment_id: paymentId,
        agent: p.agent,
        recipient: p.recipient,
        amount: p.amount,
        day: p.day,
        status: p.status,
        quote_hash: p.quote_hash,
      }));
    res.json(rows);
  }),
);

app.get('/api/attempts', (_req, res) => {
  res.json(attempts.list());
});

app.get('/api/holds', (_req, res) => {
  const holds = attempts
    .list()
    .filter((a) => a.outcome === 'blocked' && (a.reason === 'CAP' || a.reason === 'BUDGET'))
    .map((a) => ({ ...a, approvable: true }));
  res.json(holds);
});

app.post(
  '/api/holds/approve',
  wrap(async (req, res) => {
    const body = req.body as {
      agent?: string;
      resource?: string;
      sellerUrl?: string;
      amount?: string;
    };
    if (!body.agent || !body.resource || !body.sellerUrl || body.amount === undefined) {
      res.status(400).json({ error: 'agent, resource, sellerUrl and amount are required' });
      return;
    }
    const sellerUrl = body.sellerUrl.replace(/\/+$/, '');
    const quoteRes = await fetch(
      `${sellerUrl}/vault-quote?resource=${encodeURIComponent(body.resource)}`,
    );
    if (!quoteRes.ok) {
      res.status(502).json({ error: `seller quote request failed: HTTP ${quoteRes.status}` });
      return;
    }
    const { quote } = (await quoteRes.json()) as { quote: EngineQuote };
    if (quote.amount !== String(body.amount)) {
      res.status(409).json({
        error: `fresh quote amount ${quote.amount} does not match the held amount ${String(body.amount)}`,
      });
      return;
    }
    const paymentId = `pay_${randomBytes(12).toString('hex')}`;
    const record = await owner.approvePayment({
      agentId: body.agent,
      paymentId,
      quote,
    });
    res.json({ payment_id: paymentId, ...record });
  }),
);

app.post(
  '/api/pause',
  wrap(async (req, res) => {
    const paused = Boolean((req.body as { paused?: unknown }).paused);
    if (paused) {
      await owner.pauseAll();
    } else {
      await owner.resumeAll();
    }
    res.json({ ok: true, paused });
  }),
);

app.post(
  '/api/agents/:id/revoke',
  wrap(async (req, res) => {
    await owner.revoke(req.params['id'] as string);
    res.json({ ok: true, agent: req.params['id'], status: 'Revoked' });
  }),
);

app.post(
  '/api/agents/:id/reactivate',
  wrap(async (req, res) => {
    await owner.reactivate(req.params['id'] as string);
    res.json({ ok: true, agent: req.params['id'], status: 'Active' });
  }),
);

app.use(express.static(path.join(APP_DIR, 'public')));

app.listen(PORT, () => {
  console.log(`stipend console on :${PORT} — engine ${CONTRACT_ID}`);
});
