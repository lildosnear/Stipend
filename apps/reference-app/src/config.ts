/**
 * Configuration for the Stipend reference app. The seller, the demo agent
 * and the attack scenes all read the same environment.
 *
 * Key material comes in two shapes:
 *   - NEAR CLI key files ({account_id, private_key}) sign engine calls.
 *   - Base64 seed files (.priv.b64) hold the ed25519 quote and approval
 *     keys; only the raw seed text is used, never a NEAR account key.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineClient } from '@stipend/sdk';

/** This app's directory (apps/reference-app), from dist or src alike. */
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface ReferenceConfig {
  contractId: string;
  rpcUrl: string;
  /** The seller's NEAR account: quote recipient and payment destination. */
  sellerAccountId: string;
  /** NEAR CLI key file for the seller account (optional; views only). */
  sellerKeyPath: string | null;
  /** Base64 seed file for the seller's quote key. */
  sellerQuotePrivPath: string | null;
  /** Engine level agent id the demo agent spends as. */
  agentId: string;
  /** Account authorized on chain to submit payments for the agent. */
  agentAccountId: string;
  /** NEAR CLI key file for the agent's authorized caller account. */
  agentKeyPath: string | null;
  attemptsPath: string;
  sellerPort: number;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function required(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

export function loadConfig(): ReferenceConfig {
  const attemptsEnv = env('STIPEND_ATTEMPTS_PATH');
  return {
    contractId: required('STIPEND_CONTRACT_ID'),
    rpcUrl: env('STIPEND_RPC_URL') ?? 'https://rpc.testnet.near.org',
    sellerAccountId: env('SELLER_ACCOUNT_ID') ?? '',
    sellerKeyPath: env('SELLER_KEY_PATH') ?? null,
    sellerQuotePrivPath: env('SELLER_QUOTE_PRIV_PATH') ?? null,
    agentId: env('STIPEND_AGENT_ID') ?? 'bot',
    agentAccountId: env('AGENT_ACCOUNT_ID') ?? '',
    agentKeyPath: env('AGENT_KEY_PATH') ?? null,
    // Default: <repo root>/data/attempts.json, shared with the console.
    attemptsPath: attemptsEnv
      ? path.resolve(attemptsEnv)
      : path.resolve(APP_DIR, '../../data/attempts.json'),
    sellerPort: Number(env('SELLER_PORT') ?? '8787'),
  };
}

/** Read a NEAR CLI key file ({account_id, private_key}). */
export function readKeyJson(filePath: string): { accountId: string; privateKey: string } {
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
export function readSeed(filePath: string): string {
  if (!existsSync(filePath)) throw new Error(`seed file not found: ${filePath}`);
  return readFileSync(filePath, 'utf8').trim();
}

/** Build an EngineClient signing as the given account. */
export function buildEngine(
  cfg: ReferenceConfig,
  accountId: string,
  keyPath: string | null,
  what: string,
): EngineClient {
  if (!accountId || !keyPath) {
    throw new Error(`${what}: set the account id and key path env for this signer`);
  }
  const key = readKeyJson(keyPath);
  return new EngineClient({
    networkId: 'testnet',
    nodeUrl: cfg.rpcUrl,
    contractId: cfg.contractId,
    accountId,
    privateKey: key.privateKey,
  });
}

/** An EngineClient signing with the agent's authorized caller key. */
export function agentEngine(cfg: ReferenceConfig): EngineClient {
  return buildEngine(cfg, cfg.agentAccountId, cfg.agentKeyPath, 'agent signer');
}
