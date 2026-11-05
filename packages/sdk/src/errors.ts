/**
 * Typed errors for Stipend. On chain rejections surface as panics from the
 * contract; codeFromPanic maps the panic text onto a small stable vocabulary
 * so agent code can branch on the code instead of matching strings.
 */

export class StipendError extends Error {
  readonly code: string;
  /** Set when a blocked payment was filed as an on chain hold. */
  holdId?: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StipendError';
    this.code = code;
  }
}

const PANIC_CODES: ReadonlyArray<readonly [needle: string, code: string]> = [
  ['per-payment cap exceeded', 'CAP'],
  ['daily budget exceeded', 'BUDGET'],
  ['not allowlisted', 'VENDOR'],
  ['unknown vendor', 'VENDOR'],
  ['quote expired', 'EXPIRED'],
  ['agent revoked', 'REVOKED'],
  ['engine paused', 'PAUSED'],
  ['paused', 'PAUSED'],
  ['caller not authorized', 'CALLER'],
  ['bad quote signature', 'SIGNATURE'],
  ['bad grant signature', 'SIGNATURE'],
];

/** Map a chain error message (usually a contract panic) to a Stipend code. */
export function codeFromPanic(message: string): string {
  for (const [needle, code] of PANIC_CODES) {
    if (message.includes(needle)) return code;
  }
  return 'CHAIN';
}
