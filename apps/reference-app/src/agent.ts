/**
 * The demo agent: an AI application spending through its stipend.
 *
 * It buys the cheap market report three times (each settles on its own),
 * then tries the deep dive at 0.08 NEAR, above the standard 0.05 demo cap.
 * The engine blocks that one and it lands in the attempt log as a hold the
 * owner can approve in the console. A blocked deep dive is the expected
 * outcome, so the script still exits 0.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { AttemptLog, createStipendClient, StipendError } from '@stipend/sdk';
import { agentEngine, loadConfig } from './config.js';

/** Format a yocto amount as NEAR, string based, up to 6 decimals. */
function fmtNear(yocto: string): string {
  let digits = String(yocto);
  if (!/^\d+$/.test(digits)) digits = BigInt(Math.round(Number(digits))).toString();
  digits = digits.padStart(25, '0');
  const whole = digits.slice(0, digits.length - 24);
  const frac = digits
    .slice(digits.length - 24, digits.length - 18)
    .replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const engine = agentEngine(cfg);

  // The attempt log creates its file but not its directory.
  mkdirSync(path.dirname(cfg.attemptsPath), { recursive: true });
  const attemptLog = new AttemptLog(cfg.attemptsPath);

  const client = createStipendClient({
    engine,
    agentId: cfg.agentId,
    sellerBaseUrl: `http://localhost:${cfg.sellerPort}`,
    attemptLog,
  });

  console.log(`agent "${cfg.agentId}" spending through its stipend on ${cfg.contractId}`);

  for (let i = 1; i <= 3; i += 1) {
    const { receipt, delivery } = await client.purchase('data:market-report');
    console.log(
      `purchase ${i}: ${receipt.status}, ${fmtNear(receipt.amount)} NEAR to ${receipt.recipient}`,
    );
    console.log(`  delivered: ${JSON.stringify(delivery).slice(0, 140)}`);
  }

  console.log('attempting data:deep-dive (0.08 NEAR, above the 0.05 demo cap)...');
  try {
    const { receipt } = await client.purchase('data:deep-dive');
    console.log(
      `deep dive settled: ${receipt.status}, ${fmtNear(receipt.amount)} NEAR to ${receipt.recipient}`,
    );
  } catch (e) {
    if (e instanceof StipendError) {
      console.log(`deep dive held back by the engine [${e.code}]: ${e.message}`);
      console.log('the owner can approve this payment in the console, on the Holds page.');
      return;
    }
    throw e;
  }
}

main().catch((e: unknown) => {
  console.error(`agent failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
