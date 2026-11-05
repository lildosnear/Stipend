/**
 * Blocked and settled attempts, kept off chain.
 *
 * A contract panic rolls back all state, so the engine keeps no record of
 * the payments it rejected. This small JSON file log is where those
 * rejections (and the successes) are recorded by the SDK and read by the
 * owner console.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AttemptRecord {
  /** epoch milliseconds */
  ts: number;
  payment_id: string;
  agent: string;
  recipient: string;
  /** decimal string, yoctoNEAR */
  amount: string;
  outcome: 'blocked' | 'succeeded';
  /** Stipend error code when blocked */
  reason?: string;
  /** On chain hold id when the blocked payment was filed for approval */
  hold_id?: string;
  resource?: string;
  sellerUrl?: string;
}

export class AttemptLog {
  constructor(private readonly filePath: string) {}

  /** Append one record, creating the folder and file when needed. */
  append(rec: AttemptRecord): void {
    const all = this.readAll();
    all.push(rec);
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(all, null, 2));
  }

  /** All records, newest first. A missing file reads as empty. */
  list(): AttemptRecord[] {
    return this.readAll().slice().reverse();
  }

  private readAll(): AttemptRecord[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return Array.isArray(parsed) ? (parsed as AttemptRecord[]) : [];
    } catch {
      return [];
    }
  }
}
