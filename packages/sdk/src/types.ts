/** Wire types shared with the Stipend policy engine contract. */

/** A vendor signed quote, exactly as the contract expects it. */
export interface EngineQuote {
  recipient: string;
  /** decimal string, yoctoNEAR */
  amount: string;
  /** base64 sha256 of the service terms */
  terms_hash: string;
  /** nanosecond expiry; whole seconds only (exact as a JSON number) */
  expiry_ns: number;
  quote_id: string;
  /** base64 ed25519 signature over the canonical quote payload */
  signature: string;
}

/** An owner signed exception grant, exactly as the contract expects it. */
export interface EngineGrant {
  agent: string;
  recipient: string;
  /** decimal string, yoctoNEAR */
  amount_max: string;
  /** base64 ed25519 public key that signs quotes on the exception path */
  merchant_key: string;
  /** nanosecond expiry; whole seconds only */
  expiry_ns: number;
  nonce: string;
  policy_version: number;
  /** base64 ed25519 signature by the approval key */
  signature: string;
}

/** Fields needed to build (and sign) a quote, before the signature exists. */
export interface UnsignedQuote {
  recipient: string;
  amount: bigint | string;
  termsHash: Buffer;
  expiryNs: bigint | number;
  quoteId: string;
}

/** Fields needed to build (and sign) a grant, before the signature exists. */
export interface UnsignedGrant {
  agent: string;
  recipient: string;
  amountMax: bigint | string;
  merchantKey: Buffer;
  expiryNs: bigint | number;
  nonce: string;
  policyVersion: number;
}

/** One approved vendor in an agent's allowlist. */
export interface AllowlistEntry {
  account: string;
  /** base64 ed25519 public key the vendor signs quotes with */
  quote_key: string;
  label: string;
}

/** An agent's stipend as stored in the engine. */
export interface StipendAgent {
  status: string;
  policy_version: number;
  /** decimal string, yoctoNEAR */
  per_payment_cap: string;
  /** decimal string, yoctoNEAR */
  daily_budget: string;
  authorized_callers: string[];
  allowlist: AllowlistEntry[];
}

/** A payment record as stored in the engine. */
export interface PaymentRecord {
  agent: string;
  recipient: string;
  /** decimal string, yoctoNEAR */
  amount: string;
  day: number;
  status: string;
  /** base64 sha256 of the canonical quote payload */
  quote_hash: string;
}
