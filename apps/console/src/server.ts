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
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import { AttemptLog, EngineClient, createOwnerTools } from '@stipend/sdk';

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
const OWNER_ACCOUNT_ID = env('STIPEND_OWNER_ACCOUNT_ID') ?? CONTRACT_ID;
const OWNER_KEY_PATH = env('STIPEND_OWNER_KEY_PATH');
const APPROVAL_PRIV_PATH = env('STIPEND_APPROVAL_PRIV_PATH');
const RPC_URL = env('STIPEND_RPC_URL') ?? 'https://rpc.testnet.near.org';
const ATTEMPTS_PATH = env('STIPEND_ATTEMPTS_PATH')
  ? path.resolve(env('STIPEND_ATTEMPTS_PATH') as string)
  : path.resolve(APP_DIR, '../../data/attempts.json');
const PORT = Number(env('PORT') ?? '8282');
const HOST = env('CONSOLE_HOST') ?? '127.0.0.1';

/**
 * Read only mode: without the owner key file and the approval seed the
 * console can still serve every page from chain views, which is how
 * anyone with a repo checkout can look at a live engine. Admin calls
 * are refused, because there is nothing here that may sign. The owner
 * key itself is never distributed with the code.
 */
const READ_ONLY = !(
  OWNER_KEY_PATH &&
  existsSync(OWNER_KEY_PATH) &&
  APPROVAL_PRIV_PATH &&
  existsSync(APPROVAL_PRIV_PATH)
);

const ownerKey = READ_ONLY
  ? { accountId: OWNER_ACCOUNT_ID, privateKey: 'ed25519:11111111111111111111111111111111' }
  : readKeyJson(OWNER_KEY_PATH as string);
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
  approvalPrivateKeyBase64: READ_ONLY
    ? 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
    : readSeed(APPROVAL_PRIV_PATH as string),
});
const attempts = new AttemptLog(ATTEMPTS_PATH);
/**
 * Owner token guarding every state changing call. The console process
 * holds the engine owner key, so an unauthenticated admin endpoint
 * would hand that power to anyone who can reach the port. Set
 * STIPEND_CONSOLE_TOKEN to choose the token; otherwise one is
 * generated at boot and printed once in the startup log.
 */
const CONSOLE_TOKEN = env('STIPEND_CONSOLE_TOKEN') ?? randomBytes(16).toString('hex');

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

// Owner authentication for state changing calls: every POST under /api
// must carry the owner token in the x-console-token header. Requiring
// a custom header also defeats cross site form posts (CSRF), since a
// foreign page cannot set it without a CORS preflight this server
// never grants. Reads stay open; the server binds localhost by
// default, and CONSOLE_HOST is the explicit opt in to expose it.
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path.startsWith('/api/')) {
    if (READ_ONLY) {
      res.status(503).json({ error: 'console is read only: no owner key configured' });
      return;
    }
    const given = req.header('x-console-token');
    const a = Buffer.from(given ?? '');
    const b = Buffer.from(CONSOLE_TOKEN);
    if (!given || a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).json({ error: 'owner token required' });
      return;
    }
  }
  next();
});

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
  res.json({ ok: true, contract: CONTRACT_ID, readOnly: READ_ONLY });
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

app.get(
  '/api/holds',
  wrap(async (_req, res) => {
    const entries = await engine.listHolds(0, 200);
    const rows = entries
      .slice()
      .reverse()
      .map(([holdId, h]) => ({
        hold_id: holdId,
        agent: h.agent,
        recipient: h.recipient,
        amount: h.amount,
        reason: h.reason,
        status: h.status,
        created_ns: h.created_ns,
        expires_ns: h.expires_ns,
        payment_id: h.payment_id,
      }));
    res.json(rows);
  }),
);

app.post(
  '/api/holds/approve',
  wrap(async (req, res) => {
    const body = req.body as { hold_id?: string };
    if (!body.hold_id) {
      res.status(400).json({ error: 'hold_id is required' });
      return;
    }
    const hold = await engine.getHold(body.hold_id);
    if (!hold) {
      res.status(404).json({ error: `unknown hold ${body.hold_id}` });
      return;
    }
    if (hold.status === 'PendingApproval') {
      // The SDK owner tool runs the decision and the execution as the
      // two separate on chain steps they are.
      const record = await owner.approveHold(body.hold_id);
      const after = await engine.getHold(body.hold_id);
      res.json({ payment_id: after?.payment_id ?? null, ...record });
      return;
    }
    if (hold.status === 'Approved') {
      // Already decided, execution still outstanding (for example the
      // daily budget blocked the first attempt): execute only.
      const paymentId = `pay_${randomBytes(12).toString('hex')}`;
      await engine.executeHold(body.hold_id, paymentId);
      const record = await engine.pollPayment(paymentId);
      res.json({ payment_id: paymentId, ...record });
      return;
    }
    res.status(409).json({ error: `hold is ${hold.status}, not approvable` });
  }),
);

app.post(
  '/api/holds/reject',
  wrap(async (req, res) => {
    const body = req.body as { hold_id?: string };
    if (!body.hold_id) {
      res.status(400).json({ error: 'hold_id is required' });
      return;
    }
    const status = await owner.rejectHold(body.hold_id);
    res.json({ ok: true, hold_id: body.hold_id, status });
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

app.listen(PORT, HOST, () => {
  console.log(`stipend console on ${HOST}:${PORT} — engine ${CONTRACT_ID}`);
  if (READ_ONLY) {
    console.log('read only mode: no owner key configured, admin actions are disabled');
  } else {
    console.log(`owner token for admin actions: ${CONSOLE_TOKEN}`);
  }
});
