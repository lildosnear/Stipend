//! Stipend policy engine.
//!
//! An owner opens a stipend for an agent: a cap per payment, a budget per
//! day, and a list of approved vendors, each with the key that signs its
//! quotes. Every payment is checked against the stipend before any funds
//! move. A payment that fits settles at once. One above the per payment cap
//! can still settle with a one time owner signed exception grant. The owner
//! can pause payments (all of them, or only exceptions) and revoke an agent.
//!
//! Design rules carried in from the start:
//! - Amounts cross the JSON boundary as raw numbers, never strings: the
//!   amount fields below are plain u128.
//! - Quote and grant expiries are whole seconds, so they survive JSON
//!   number encoding exactly and signatures verify against what was signed.
//! - A payment id is idempotent: a retry with identical details returns
//!   the stored outcome and never pays twice; reuse with different
//!   details is rejected.
//! - Signatures are ed25519 over canonical payloads (see `quote_payload`
//!   and `grant_payload`), so the SDK and the contract agree byte for byte.

use near_sdk::collections::{LookupMap, LookupSet, UnorderedMap};
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::json;
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

/// Nanoseconds in one day; the daily budget window is the UTC day number.
pub const NS_PER_DAY: u64 = 86_400_000_000_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum AgentStatus {
    Active,
    Revoked,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum PaymentStatus {
    InFlight,
    Succeeded,
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct AllowEntry {
    pub account: AccountId,
    pub quote_key: Base64VecU8,
    pub label: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Agent {
    pub status: AgentStatus,
    pub per_payment_cap: u128,
    pub daily_budget: u128,
    pub authorized_callers: Vec<AccountId>,
    pub allowlist: Vec<AllowEntry>,
    pub policy_version: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Payment {
    pub agent: String,
    pub recipient: AccountId,
    pub amount: u128,
    pub day: u64,
    pub status: PaymentStatus,
    /// Base64 sha256 of the canonical quote payload.
    pub quote_hash: String,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct Quote {
    pub recipient: AccountId,
    pub amount: u128,
    pub terms_hash: Base64VecU8,
    pub expiry_ns: u64,
    pub quote_id: String,
    pub signature: Base64VecU8,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct Grant {
    pub agent: String,
    pub recipient: AccountId,
    pub amount_max: u128,
    pub merchant_key: Base64VecU8,
    pub expiry_ns: u64,
    pub nonce: String,
    pub policy_version: u64,
    pub signature: Base64VecU8,
}

/// Lifecycle of an on chain hold: a payment the engine blocked on a
/// policy limit (cap or daily budget), filed for the owner's decision.
/// PendingApproval -> Approved -> Executed, or -> Rejected, or -> Expired.
#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum HoldStatus {
    PendingApproval,
    Approved,
    Rejected,
    Expired,
    Executed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Hold {
    pub agent: String,
    pub recipient: AccountId,
    pub amount: u128,
    /// Base64 sha256 of the canonical quote payload, as on Payment.
    pub quote_hash: String,
    /// The vendor quote key the quote was verified against (base64).
    pub merchant_key: Base64VecU8,
    /// Why the payment was held: "CAP" or "BUDGET".
    pub reason: String,
    pub status: HoldStatus,
    pub created_ns: u64,
    pub expires_ns: u64,
    pub payment_id: Option<String>,
}

/// How long a filed hold stays decidable: 24 hours in nanoseconds.
pub const HOLD_TTL_NS: u64 = 86_400_000_000_000;

// ---------------------------------------------------------------------------
// Canonical signing payloads
// ---------------------------------------------------------------------------

fn push_field(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(bytes);
}

/// Canonical quote payload:
/// "STIPEND-QUOTE-v1" + field(vault) + field(recipient) + u128 LE(amount)
/// + field(terms_hash) + u64 LE(expiry_ns) + field(quote_id).
pub fn quote_payload(
    vault_account_id: &str,
    recipient: &str,
    amount: u128,
    terms_hash: &[u8],
    expiry_ns: u64,
    quote_id: &str,
) -> Vec<u8> {
    let mut out = b"STIPEND-QUOTE-v1".to_vec();
    push_field(&mut out, vault_account_id.as_bytes());
    push_field(&mut out, recipient.as_bytes());
    out.extend_from_slice(&amount.to_le_bytes());
    push_field(&mut out, terms_hash);
    out.extend_from_slice(&expiry_ns.to_le_bytes());
    push_field(&mut out, quote_id.as_bytes());
    out
}

/// Canonical grant payload:
/// "STIPEND-GRANT-v1" + field(vault) + field(agent) + field(recipient)
/// + u128 LE(amount_max) + field(merchant_key) + u64 LE(expiry_ns)
/// + field(nonce) + u64 LE(policy_version).
pub fn grant_payload(
    vault_account_id: &str,
    agent: &str,
    recipient: &str,
    amount_max: u128,
    merchant_key: &[u8],
    expiry_ns: u64,
    nonce: &str,
    policy_version: u64,
) -> Vec<u8> {
    let mut out = b"STIPEND-GRANT-v1".to_vec();
    push_field(&mut out, vault_account_id.as_bytes());
    push_field(&mut out, agent.as_bytes());
    push_field(&mut out, recipient.as_bytes());
    out.extend_from_slice(&amount_max.to_le_bytes());
    push_field(&mut out, merchant_key);
    out.extend_from_slice(&expiry_ns.to_le_bytes());
    push_field(&mut out, nonce.as_bytes());
    out.extend_from_slice(&policy_version.to_le_bytes());
    out
}

fn payload_of_quote(vault_account_id: &str, quote: &Quote) -> Vec<u8> {
    quote_payload(
        vault_account_id,
        quote.recipient.as_str(),
        quote.amount,
        &quote.terms_hash.0,
        quote.expiry_ns,
        &quote.quote_id,
    )
}

fn payload_of_grant(vault_account_id: &str, grant: &Grant) -> Vec<u8> {
    grant_payload(
        vault_account_id,
        &grant.agent,
        grant.recipient.as_str(),
        grant.amount_max,
        &grant.merchant_key.0,
        grant.expiry_ns,
        &grant.nonce,
        grant.policy_version,
    )
}

const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64_ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(B64_ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64_ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64_ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Base64 sha256 of the canonical quote payload; identifies a payment's
/// exact terms for idempotency checks.
pub fn quote_hash(vault_account_id: &str, quote: &Quote) -> String {
    base64_encode(&env::sha256(&payload_of_quote(vault_account_id, quote)))
}

fn verify_signature(payload: &[u8], signature: &Base64VecU8, public_key: &[u8]) -> bool {
    let sig: [u8; 64] = match signature.0.as_slice().try_into() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let pk: [u8; 32] = match public_key.try_into() {
        Ok(a) => a,
        Err(_) => return false,
    };
    env::ed25519_verify(&sig, payload, &pk)
}

fn emit_event(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(
        &json!({
            "standard": "stipend",
            "version": "1.0.0",
            "event": event,
            "data": data,
        })
        .to_string(),
    );
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Engine {
    owner: AccountId,
    approval_key: [u8; 32],
    agents: UnorderedMap<String, Agent>,
    payments: UnorderedMap<String, Payment>,
    /// (agent_id, day) -> amount spent or in flight that day.
    spent: LookupMap<(String, u64), u128>,
    used_nonces: LookupSet<String>,
    /// Payment ids that have reached a final state.
    finalized: LookupSet<String>,
    paused_all: bool,
    paused_exceptions: bool,
    total_in_flight: u128,
    holds: UnorderedMap<String, Hold>,
}

/// The pre queue state layout, kept only so migrate() can read state
/// written by the first deployed version of this contract.
#[near(serializers = [borsh])]
struct OldEngine {
    owner: AccountId,
    approval_key: [u8; 32],
    agents: UnorderedMap<String, Agent>,
    payments: UnorderedMap<String, Payment>,
    spent: LookupMap<(String, u64), u128>,
    used_nonces: LookupSet<String>,
    finalized: LookupSet<String>,
    paused_all: bool,
    paused_exceptions: bool,
    total_in_flight: u128,
}

/// Guard for policy checks: fail with an explicit on chain panic so the
/// message always reaches the caller. A plain Rust panic in this crate
/// (panic = "abort") surfaces as a bare WebAssembly trap with no message,
/// and the SDK maps these exact strings to typed error codes.
fn require(cond: bool, msg: &str) {
    if !cond {
        env::panic_str(msg);
    }
}

#[near]
impl Engine {
    #[init]
    pub fn new(owner: AccountId, approval_key: Base64VecU8) -> Self {
        let key: [u8; 32] = approval_key
            .0
            .as_slice()
            .try_into()
            .unwrap_or_else(|_| env::panic_str("approval key must be 32 bytes"));
        Self {
            owner,
            approval_key: key,
            agents: UnorderedMap::new(b"a"),
            payments: UnorderedMap::new(b"p"),
            spent: LookupMap::new(b"s"),
            used_nonces: LookupSet::new(b"n"),
            finalized: LookupSet::new(b"f"),
            paused_all: false,
            paused_exceptions: false,
            total_in_flight: 0,
            holds: UnorderedMap::new(b"h"),
        }
    }

    /// Upgrade path from the pre queue layout: carry every field over and
    /// start with an empty hold queue. Callable only by the contract
    /// account itself, immediately after the new code is deployed.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: OldEngine =
            env::state_read().unwrap_or_else(|| env::panic_str("no state to migrate"));
        Self {
            owner: old.owner,
            approval_key: old.approval_key,
            agents: old.agents,
            payments: old.payments,
            spent: old.spent,
            used_nonces: old.used_nonces,
            finalized: old.finalized,
            paused_all: old.paused_all,
            paused_exceptions: old.paused_exceptions,
            total_in_flight: old.total_in_flight,
            holds: UnorderedMap::new(b"h"),
        }
    }

    /// Spendable balance: what is actually in the account, minus what is
    /// already promised to in flight payments, minus the storage reserve
    /// the account must keep. Admission and withdraw share this formula.
    fn available_balance(&self) -> u128 {
        let reserve =
            env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
        env::account_balance()
            .as_yoctonear()
            .saturating_sub(self.total_in_flight)
            .saturating_sub(reserve)
    }

    // ----- administration (owner only) ------------------------------------

    fn assert_owner(&self) {
        require(env::predecessor_account_id() == self.owner, "not owner");
    }

    pub fn register_agent(
        &mut self,
        agent_id: String,
        per_payment_cap: u128,
        daily_budget: u128,
        authorized_callers: Vec<AccountId>,
        allowlist: Vec<AllowEntry>,
    ) {
        self.assert_owner();
        require(self.agents.get(&agent_id).is_none(), "agent exists");
        let agent = Agent {
            status: AgentStatus::Active,
            per_payment_cap,
            daily_budget,
            authorized_callers,
            allowlist,
            policy_version: 1,
        };
        self.agents.insert(&agent_id, &agent);
        emit_event("agent_registered", json!({ "agent": agent_id }));
    }

    pub fn update_agent_policy(
        &mut self,
        agent_id: String,
        per_payment_cap: Option<u128>,
        daily_budget: Option<u128>,
        authorized_callers: Option<Vec<AccountId>>,
    ) {
        self.assert_owner();
        let mut agent = self.agents.get(&agent_id).unwrap_or_else(|| env::panic_str("unknown agent"));
        if let Some(v) = per_payment_cap {
            agent.per_payment_cap = v;
        }
        if let Some(v) = daily_budget {
            agent.daily_budget = v;
        }
        if let Some(v) = authorized_callers {
            agent.authorized_callers = v;
        }
        agent.policy_version += 1;
        self.agents.insert(&agent_id, &agent);
    }

    pub fn set_allowlist(&mut self, agent_id: String, allowlist: Vec<AllowEntry>) {
        self.assert_owner();
        let mut agent = self.agents.get(&agent_id).unwrap_or_else(|| env::panic_str("unknown agent"));
        agent.allowlist = allowlist;
        agent.policy_version += 1;
        self.agents.insert(&agent_id, &agent);
    }

    pub fn revoke_agent(&mut self, agent_id: String, reason: Option<String>) {
        self.assert_owner();
        let mut agent = self.agents.get(&agent_id).unwrap_or_else(|| env::panic_str("unknown agent"));
        agent.status = AgentStatus::Revoked;
        agent.policy_version += 1;
        self.agents.insert(&agent_id, &agent);
        emit_event("agent_revoked", json!({ "agent": agent_id, "reason": reason }));
    }

    pub fn reactivate_agent(&mut self, agent_id: String, authorized_callers: Option<Vec<AccountId>>) {
        self.assert_owner();
        let mut agent = self.agents.get(&agent_id).unwrap_or_else(|| env::panic_str("unknown agent"));
        require(matches!(agent.status, AgentStatus::Revoked), "agent not revoked");
        agent.status = AgentStatus::Active;
        if let Some(v) = authorized_callers {
            agent.authorized_callers = v;
        }
        agent.policy_version += 1;
        self.agents.insert(&agent_id, &agent);
        emit_event("agent_reactivated", json!({ "agent": agent_id }));
    }

    pub fn set_approval_key(&mut self, key: Base64VecU8) {
        self.assert_owner();
        let key: [u8; 32] = key
            .0
            .as_slice()
            .try_into()
            .unwrap_or_else(|_| env::panic_str("approval key must be 32 bytes"));
        self.approval_key = key;
    }

    pub fn set_paused_all(&mut self, paused: bool) {
        self.assert_owner();
        self.paused_all = paused;
        emit_event("paused_all", json!({ "paused": paused }));
    }

    pub fn set_paused_exceptions(&mut self, paused: bool) {
        self.assert_owner();
        self.paused_exceptions = paused;
        emit_event("paused_exceptions", json!({ "paused": paused }));
    }

    // ----- payments ---------------------------------------------------------

    pub fn request_payment(
        &mut self,
        agent_id: String,
        payment_id: String,
        quote: Quote,
        grant: Option<Grant>,
    ) -> PaymentStatus {
        let vault_id = env::current_account_id();
        let vault = vault_id.as_str();
        let this_hash = quote_hash(vault, &quote);

        // 1. Idempotent retry: a known payment id with identical params is
        //    a status query, not a second payment.
        if let Some(existing) = self.payments.get(&payment_id) {
            if existing.agent == agent_id
                && existing.recipient == quote.recipient
                && existing.amount == quote.amount
                && existing.quote_hash == this_hash
            {
                return existing.status;
            }
            env::panic_str("payment ID reused with different params");
        }

        // 2. Global pause.
        require(!self.paused_all, "engine paused");

        // 3. Agent must exist and be active.
        let agent = self.agents.get(&agent_id).unwrap_or_else(|| env::panic_str("unknown agent"));
        require(matches!(agent.status, AgentStatus::Active), "agent revoked");

        // 4. Caller must be authorized for the agent.
        let caller = env::predecessor_account_id();
        require(agent.authorized_callers.contains(&caller), "caller not authorized");

        // 5. The spendable balance (after in flight obligations and the
        //    storage reserve) must cover the payment.
        require(
            quote.amount <= self.available_balance(),
            "insufficient engine balance"
        );

        let now = env::block_timestamp();

        // 6. Policy path: exception grant, or the plain allowlist path.
        if let Some(g) = &grant {
            require(!self.paused_exceptions, "exceptions paused");
            let sig_ok = verify_signature(&payload_of_grant(vault, g), &g.signature, &self.approval_key);
            require(
                sig_ok && g.agent == agent_id && g.recipient == quote.recipient,
                "bad grant signature"
            );
            require(g.expiry_ns > now, "grant expired");
            require(quote.amount <= g.amount_max, "grant amount exceeded");
            require(g.policy_version == agent.policy_version, "grant policy version mismatch");
            require(!self.used_nonces.contains(&g.nonce), "grant already used");
            require(
                verify_signature(&payload_of_quote(vault, &quote), &quote.signature, &g.merchant_key.0),
                "bad quote signature"
            );
            require(quote.expiry_ns > now, "quote expired");
        } else {
            let entry = agent
                .allowlist
                .iter()
                .find(|e| e.account == quote.recipient)
                .unwrap_or_else(|| env::panic_str("vendor not allowlisted"));
            require(
                verify_signature(&payload_of_quote(vault, &quote), &quote.signature, &entry.quote_key.0),
                "bad quote signature"
            );
            require(quote.expiry_ns > now, "quote expired");
            require(quote.amount <= agent.per_payment_cap, "per-payment cap exceeded");
        }

        // 7. Daily budget, counting in flight amounts.
        let today = now / NS_PER_DAY;
        let spent_key = (agent_id.clone(), today);
        let spent_today = self.spent.get(&spent_key).unwrap_or(0);
        require(
            spent_today + quote.amount <= agent.daily_budget,
            "daily budget exceeded"
        );

        // 8. Commit and transfer.
        if let Some(g) = &grant {
            self.used_nonces.insert(&g.nonce);
        }
        self.commit_payment(&agent_id, &payment_id, &quote.recipient, quote.amount, &this_hash, today)
    }

    /// Record a payment as InFlight, charge it against the day's budget,
    /// and start the transfer with its finalization callback. Callers run
    /// every policy check first; this is the shared money moving step for
    /// direct payments and executed holds.
    fn commit_payment(
        &mut self,
        agent_id: &str,
        payment_id: &str,
        recipient: &AccountId,
        amount: u128,
        qhash: &str,
        today: u64,
    ) -> PaymentStatus {
        let spent_key = (agent_id.to_string(), today);
        let spent_today = self.spent.get(&spent_key).unwrap_or(0);
        let payment = Payment {
            agent: agent_id.to_string(),
            recipient: recipient.clone(),
            amount,
            day: today,
            status: PaymentStatus::InFlight,
            quote_hash: qhash.to_string(),
        };
        self.payments.insert(&payment_id.to_string(), &payment);
        self.spent.insert(&spent_key, &(spent_today + amount));
        self.total_in_flight += amount;
        emit_event(
            "payment_submitted",
            json!({
                "payment_id": payment_id,
                "agent": agent_id,
                "recipient": recipient,
                "amount": amount.to_string(),
            }),
        );
        let callback_args =
            json!({ "payment_id": payment_id }).to_string().into_bytes();
        let _ = Promise::new(recipient.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_payment_complete".to_string(),
                    callback_args,
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(5),
                ),
            );
        PaymentStatus::InFlight
    }

    /// Shared finalization: mark a payment Succeeded or Failed, refund the
    /// daily budget on failure, and release the in flight amount. Guarded
    /// by the tombstone set so a payment finalizes exactly once.
    fn finalize_payment(&mut self, payment_id: &str, succeeded: bool) -> PaymentStatus {
        if self.finalized.contains(&payment_id.to_string()) {
            return self
                .payments
                .get(&payment_id.to_string())
                .map(|p| p.status)
                .unwrap_or(PaymentStatus::Failed);
        }
        let mut payment = match self.payments.get(&payment_id.to_string()) {
            Some(p) => p,
            None => return PaymentStatus::Failed,
        };
        if !matches!(payment.status, PaymentStatus::InFlight) {
            return payment.status;
        }
        if succeeded {
            payment.status = PaymentStatus::Succeeded;
        } else {
            payment.status = PaymentStatus::Failed;
            let key = (payment.agent.clone(), payment.day);
            let current = self.spent.get(&key).unwrap_or(0);
            self.spent.insert(&key, &current.saturating_sub(payment.amount));
        }
        self.total_in_flight = self.total_in_flight.saturating_sub(payment.amount);
        self.payments.insert(&payment_id.to_string(), &payment);
        self.finalized.insert(&payment_id.to_string());
        emit_event(
            "payment_finalized",
            json!({ "payment_id": payment_id, "succeeded": succeeded }),
        );
        payment.status
    }

    #[private]
    pub fn on_payment_complete(
        &mut self,
        payment_id: String,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> PaymentStatus {
        if self.finalized.contains(&payment_id) {
            return self
                .payments
                .get(&payment_id)
                .map(|p| p.status)
                .unwrap_or(PaymentStatus::Failed);
        }
        self.finalize_payment(&payment_id, result.is_ok())
    }

    /// Owner recovery for a payment whose callback never landed: finalize
    /// it from off chain evidence, refunding the budget when it failed.
    pub fn recover_payment(
        &mut self,
        payment_id: String,
        succeeded: bool,
        evidence_ref: String,
    ) -> PaymentStatus {
        self.assert_owner();
        let payment = self.payments.get(&payment_id).unwrap_or_else(|| env::panic_str("unknown payment"));
        require(matches!(payment.status, PaymentStatus::InFlight), "payment not in flight");
        let status = self.finalize_payment(&payment_id, succeeded);
        emit_event(
            "payment_recovered",
            json!({
                "payment_id": payment_id,
                "succeeded": succeeded,
                "evidence_ref": evidence_ref,
            }),
        );
        status
    }

    /// Withdraw funds that are not in flight and not needed for storage.
    pub fn withdraw(&mut self, amount: u128) {
        self.assert_owner();
        require(amount <= self.available_balance(), "withdraw exceeds available");
        let _ = Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount));
    }

    // ----- holds: the on chain approval queue ------------------------------

    /// File a blocked payment as an on chain hold for the owner's
    /// decision. Only policy limit blocks can be held: the quote must be
    /// genuine (allowlisted vendor, valid signature, not expired), and
    /// the payment must actually break the cap or the daily budget.
    /// Anything else panics with the same message request_payment uses.
    pub fn request_hold(
        &mut self,
        hold_id: String,
        agent_id: String,
        quote: Quote,
    ) -> HoldStatus {
        let vault_id = env::current_account_id();
        let vault = vault_id.as_str();
        let this_hash = quote_hash(vault, &quote);

        // Idempotent retry, mirroring payments.
        if let Some(existing) = self.holds.get(&hold_id) {
            if existing.agent == agent_id
                && existing.recipient == quote.recipient
                && existing.amount == quote.amount
                && existing.quote_hash == this_hash
            {
                return existing.status;
            }
            env::panic_str("hold ID reused with different params");
        }

        let agent = self.agents.get(&agent_id).unwrap_or_else(|| env::panic_str("unknown agent"));
        require(matches!(agent.status, AgentStatus::Active), "agent revoked");
        let caller = env::predecessor_account_id();
        require(agent.authorized_callers.contains(&caller), "caller not authorized");

        let entry = agent
            .allowlist
            .iter()
            .find(|e| e.account == quote.recipient)
            .unwrap_or_else(|| env::panic_str("vendor not allowlisted"));
        require(
            verify_signature(&payload_of_quote(vault, &quote), &quote.signature, &entry.quote_key.0),
            "bad quote signature"
        );
        let now = env::block_timestamp();
        require(quote.expiry_ns > now, "quote expired");

        // The hold reason: the first policy limit the payment breaks. A
        // payment inside policy needs no decision and cannot be held.
        let today = now / NS_PER_DAY;
        let spent_today = self.spent.get(&(agent_id.clone(), today)).unwrap_or(0);
        let reason = if quote.amount > agent.per_payment_cap {
            "CAP"
        } else if spent_today + quote.amount > agent.daily_budget {
            "BUDGET"
        } else {
            env::panic_str("payment within policy")
        };

        let hold = Hold {
            agent: agent_id.clone(),
            recipient: quote.recipient.clone(),
            amount: quote.amount,
            quote_hash: this_hash,
            merchant_key: entry.quote_key.clone(),
            reason: reason.to_string(),
            status: HoldStatus::PendingApproval,
            created_ns: now,
            expires_ns: now + HOLD_TTL_NS,
            payment_id: None,
        };
        self.holds.insert(&hold_id, &hold);
        emit_event(
            "hold_filed",
            json!({
                "hold_id": hold_id,
                "agent": agent_id,
                "recipient": quote.recipient,
                "amount": quote.amount.to_string(),
                "reason": reason,
            }),
        );
        HoldStatus::PendingApproval
    }

    /// Owner decision: approve a pending hold. Approval is the decision
    /// only; execute_hold moves the money, so the two steps stay
    /// separately auditable.
    pub fn approve_hold(&mut self, hold_id: String) -> HoldStatus {
        self.assert_owner();
        let mut hold = self.holds.get(&hold_id).unwrap_or_else(|| env::panic_str("unknown hold"));
        require(matches!(hold.status, HoldStatus::PendingApproval), "hold not pending");
        require(env::block_timestamp() <= hold.expires_ns, "hold expired");
        hold.status = HoldStatus::Approved;
        self.holds.insert(&hold_id, &hold);
        emit_event("hold_approved", json!({ "hold_id": hold_id }));
        HoldStatus::Approved
    }

    /// Owner decision: reject a pending or approved hold. Terminal.
    pub fn reject_hold(&mut self, hold_id: String) -> HoldStatus {
        self.assert_owner();
        let mut hold = self.holds.get(&hold_id).unwrap_or_else(|| env::panic_str("unknown hold"));
        require(
            matches!(hold.status, HoldStatus::PendingApproval | HoldStatus::Approved),
            "hold not decidable"
        );
        hold.status = HoldStatus::Rejected;
        self.holds.insert(&hold_id, &hold);
        emit_event("hold_rejected", json!({ "hold_id": hold_id }));
        HoldStatus::Rejected
    }

    /// Mark a pending or approved hold Expired once its window has
    /// passed. Anyone may call this; expiry is a fact, not a decision.
    pub fn expire_hold(&mut self, hold_id: String) -> HoldStatus {
        let mut hold = self.holds.get(&hold_id).unwrap_or_else(|| env::panic_str("unknown hold"));
        require(
            matches!(hold.status, HoldStatus::PendingApproval | HoldStatus::Approved),
            "hold not expirable"
        );
        require(env::block_timestamp() > hold.expires_ns, "hold not expired");
        hold.status = HoldStatus::Expired;
        self.holds.insert(&hold_id, &hold);
        emit_event("hold_expired", json!({ "hold_id": hold_id }));
        HoldStatus::Expired
    }

    /// Execute an approved hold: settle its payment under a fresh payment
    /// id. The approval waives the per payment cap for this payment only.
    /// The daily budget is still enforced at execution time, as is the
    /// spendable balance, the global pause, and the agent still being
    /// active. Callable by the owner or an authorized caller of the agent.
    pub fn execute_hold(&mut self, hold_id: String, payment_id: String) -> PaymentStatus {
        let mut hold = self.holds.get(&hold_id).unwrap_or_else(|| env::panic_str("unknown hold"));
        require(matches!(hold.status, HoldStatus::Approved), "hold not approved");
        let now = env::block_timestamp();
        require(now <= hold.expires_ns, "hold expired");
        require(!self.paused_all, "engine paused");
        require(self.payments.get(&payment_id).is_none(), "payment ID already used");

        let agent = self.agents.get(&hold.agent).unwrap_or_else(|| env::panic_str("unknown agent"));
        require(matches!(agent.status, AgentStatus::Active), "agent revoked");
        let caller = env::predecessor_account_id();
        require(
            caller == self.owner || agent.authorized_callers.contains(&caller),
            "caller not authorized"
        );
        require(hold.amount <= self.available_balance(), "insufficient engine balance");

        let today = now / NS_PER_DAY;
        let spent_today = self.spent.get(&(hold.agent.clone(), today)).unwrap_or(0);
        require(
            spent_today + hold.amount <= agent.daily_budget,
            "daily budget exceeded"
        );

        let status = self.commit_payment(
            &hold.agent.clone(),
            &payment_id,
            &hold.recipient.clone(),
            hold.amount,
            &hold.quote_hash.clone(),
            today,
        );
        hold.status = HoldStatus::Executed;
        hold.payment_id = Some(payment_id.clone());
        self.holds.insert(&hold_id, &hold);
        emit_event(
            "hold_executed",
            json!({ "hold_id": hold_id, "payment_id": payment_id }),
        );
        status
    }

    // ----- views ------------------------------------------------------------

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn get_agent(&self, agent_id: String) -> Option<Agent> {
        self.agents.get(&agent_id)
    }

    pub fn get_payment(&self, payment_id: String) -> Option<Payment> {
        self.payments.get(&payment_id)
    }

    pub fn list_agents(&self, offset: u64, limit: u64) -> Vec<(String, Agent)> {
        self.agents
            .iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect()
    }

    pub fn list_payments(&self, offset: u64, limit: u64) -> Vec<(String, Payment)> {
        self.payments
            .iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect()
    }

    pub fn get_agent_count(&self) -> u64 {
        self.agents.len()
    }

    pub fn get_payment_count(&self) -> u64 {
        self.payments.len()
    }

    pub fn get_spent(&self, agent_id: String, day: u64) -> u128 {
        self.spent.get(&(agent_id, day)).unwrap_or(0)
    }

    pub fn get_policy_version(&self, agent_id: String) -> Option<u64> {
        self.agents.get(&agent_id).map(|a| a.policy_version)
    }

    /// (paused_exceptions, paused_all)
    pub fn get_paused(&self) -> (bool, bool) {
        (self.paused_exceptions, self.paused_all)
    }

    pub fn get_total_in_flight(&self) -> u128 {
        self.total_in_flight
    }

    pub fn get_hold(&self, hold_id: String) -> Option<Hold> {
        self.holds.get(&hold_id)
    }

    pub fn list_holds(&self, offset: u64, limit: u64) -> Vec<(String, Hold)> {
        self.holds
            .iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect()
    }

    pub fn get_hold_count(&self) -> u64 {
        self.holds.len()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const VAULT: &str = "engine.testnet";
    const OWNER: &str = "owner.testnet";
    const RUNNER: &str = "runner.testnet";
    const SELLER: &str = "seller.testnet";
    /// 2023-11-14 in ns; day number 19675.
    const NOW: u64 = 1_700_000_000_000_000_000;
    const TODAY: u64 = NOW / NS_PER_DAY;
    /// Whole second expiry safely after NOW.
    const EXPIRY: u64 = 1_800_000_000_000_000_000;
    const RICH: u128 = 10_000_000_000_000_000_000_000_000; // 10 NEAR

    const APPROVAL_SEED: [u8; 32] = [3u8; 32];
    const MERCHANT_SEED: [u8; 32] = [9u8; 32];

    fn approval_signer() -> SigningKey {
        SigningKey::from_bytes(&APPROVAL_SEED)
    }

    fn merchant_signer() -> SigningKey {
        SigningKey::from_bytes(&MERCHANT_SEED)
    }

    fn pub_b64(sk: &SigningKey) -> Base64VecU8 {
        Base64VecU8(sk.verifying_key().to_bytes().to_vec())
    }

    fn set_ctx(predecessor: &str, balance: u128, timestamp: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(VAULT.parse().unwrap())
            .predecessor_account_id(predecessor.parse().unwrap())
            .signer_account_id(predecessor.parse().unwrap())
            .account_balance(NearToken::from_yoctonear(balance))
            .block_timestamp(timestamp);
        testing_env!(b.build());
    }

    fn acct(id: &str) -> AccountId {
        id.parse().unwrap()
    }

    fn setup() -> Engine {
        set_ctx(OWNER, RICH, NOW);
        Engine::new(acct(OWNER), pub_b64(&approval_signer()))
    }

    /// Registers agent "bot": cap 5000, budget 10000, caller runner,
    /// allowlist with the test merchant key for seller.testnet.
    fn register_bot(e: &mut Engine) {
        set_ctx(OWNER, RICH, NOW);
        e.register_agent(
            "bot".to_string(),
            5_000,
            10_000,
            vec![acct(RUNNER)],
            vec![AllowEntry {
                account: acct(SELLER),
                quote_key: pub_b64(&merchant_signer()),
                label: "Test API".to_string(),
            }],
        );
    }

    fn make_quote(amount: u128, signer: &SigningKey) -> Quote {
        make_quote_full(amount, EXPIRY, "q1", signer)
    }

    fn make_quote_full(amount: u128, expiry_ns: u64, quote_id: &str, signer: &SigningKey) -> Quote {
        let mut q = Quote {
            recipient: acct(SELLER),
            amount,
            terms_hash: Base64VecU8(vec![1u8; 32]),
            expiry_ns,
            quote_id: quote_id.to_string(),
            signature: Base64VecU8(vec![0u8; 64]),
        };
        let payload = payload_of_quote(VAULT, &q);
        q.signature = Base64VecU8(signer.sign(&payload).to_bytes().to_vec());
        q
    }

    fn make_grant(amount_max: u128, nonce: &str, policy_version: u64, signer: &SigningKey) -> Grant {
        let mut g = Grant {
            agent: "bot".to_string(),
            recipient: acct(SELLER),
            amount_max,
            merchant_key: pub_b64(&merchant_signer()),
            expiry_ns: EXPIRY,
            nonce: nonce.to_string(),
            policy_version,
            signature: Base64VecU8(vec![0u8; 64]),
        };
        let payload = payload_of_grant(VAULT, &g);
        g.signature = Base64VecU8(signer.sign(&payload).to_bytes().to_vec());
        g
    }

    fn hex(data: &[u8]) -> String {
        data.iter().map(|b| format!("{b:02x}")).collect()
    }

    // ----- canonical payload vectors ---------------------------------------

    #[test]
    fn quote_payload_matches_pinned_vector() {
        let payload = quote_payload(VAULT, SELLER, 1000, &[1u8; 32], 1_800_000_000_000_000_000, "q-vector");
        assert_eq!(
            hex(&payload),
            "53544950454e442d51554f54452d76310e000000656e67696e652e746573746e65740e00000073656c6c65722e746573746e6574e80300000000000000000000000000002000000001010101010101010101010101010101010101010101010101010101010101010000b49376e2fa1808000000712d766563746f72"
        );
    }

    #[test]
    fn grant_payload_matches_pinned_vector() {
        let payload = grant_payload(
            VAULT,
            "agent-1",
            SELLER,
            2000,
            &[2u8; 32],
            1_800_000_000_000_000_000,
            "n-vector",
            3,
        );
        assert_eq!(
            hex(&payload),
            "53544950454e442d4752414e542d76310e000000656e67696e652e746573746e6574070000006167656e742d310e00000073656c6c65722e746573746e6574d00700000000000000000000000000002000000002020202020202020202020202020202020202020202020202020202020202020000b49376e2fa18080000006e2d766563746f720300000000000000"
        );
    }

    // ----- administration ----------------------------------------------------

    #[test]
    fn register_and_get_agent() {
        let mut e = setup();
        register_bot(&mut e);
        let agent = e.get_agent("bot".to_string()).expect("agent must exist");
        assert_eq!(agent.per_payment_cap, 5_000);
        assert_eq!(agent.daily_budget, 10_000);
        assert_eq!(agent.policy_version, 1);
        assert!(matches!(agent.status, AgentStatus::Active));
        assert_eq!(e.get_agent_count(), 1);
        assert_eq!(e.get_policy_version("bot".to_string()), Some(1));
    }

    #[test]
    #[should_panic(expected = "agent exists")]
    fn duplicate_register_panics() {
        let mut e = setup();
        register_bot(&mut e);
        register_bot(&mut e);
    }

    #[test]
    fn policy_updates_bump_version() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(OWNER, RICH, NOW);
        e.update_agent_policy("bot".to_string(), Some(7_500), None, None);
        let agent = e.get_agent("bot".to_string()).unwrap();
        assert_eq!(agent.per_payment_cap, 7_500);
        assert_eq!(agent.daily_budget, 10_000);
        assert_eq!(agent.policy_version, 2);
    }

    // ----- happy path and finalization ---------------------------------------

    #[test]
    fn happy_path_submit_then_finalize_success() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(RUNNER, RICH, NOW);
        let quote = make_quote(1_000, &merchant_signer());
        let status = e.request_payment("bot".into(), "p1".into(), quote, None);
        assert!(matches!(status, PaymentStatus::InFlight));
        assert_eq!(e.get_spent("bot".into(), TODAY), 1_000);
        assert_eq!(e.get_total_in_flight(), 1_000);

        let status = e.finalize_payment("p1", true);
        assert!(matches!(status, PaymentStatus::Succeeded));
        let payment = e.get_payment("p1".into()).unwrap();
        assert!(matches!(payment.status, PaymentStatus::Succeeded));
        // A success keeps the budget spent.
        assert_eq!(e.get_spent("bot".into(), TODAY), 1_000);
        assert_eq!(e.get_total_in_flight(), 0);
    }

    #[test]
    fn finalize_failure_refunds_budget() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(RUNNER, RICH, NOW);
        let quote = make_quote(1_000, &merchant_signer());
        e.request_payment("bot".into(), "p1".into(), quote, None);
        let status = e.finalize_payment("p1", false);
        assert!(matches!(status, PaymentStatus::Failed));
        assert_eq!(e.get_spent("bot".into(), TODAY), 0);
        assert_eq!(e.get_total_in_flight(), 0);
    }

    // ----- plain path guardrails ----------------------------------------------

    #[test]
    #[should_panic(expected = "per-payment cap exceeded")]
    fn per_payment_cap_panics() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(RUNNER, RICH, NOW);
        let quote = make_quote(6_000, &merchant_signer());
        e.request_payment("bot".into(), "p1".into(), quote, None);
    }

    #[test]
    #[should_panic(expected = "daily budget exceeded")]
    fn daily_budget_panics_on_second_payment() {
        let mut e = setup();
        set_ctx(OWNER, RICH, NOW);
        e.register_agent(
            "bot".to_string(),
            5_000,
            1_500,
            vec![acct(RUNNER)],
            vec![AllowEntry {
                account: acct(SELLER),
                quote_key: pub_b64(&merchant_signer()),
                label: "Test API".to_string(),
            }],
        );
        set_ctx(RUNNER, RICH, NOW);
        let q1 = make_quote_full(1_000, EXPIRY, "q1", &merchant_signer());
        e.request_payment("bot".into(), "p1".into(), q1, None);
        let q2 = make_quote_full(1_000, EXPIRY, "q2", &merchant_signer());
        e.request_payment("bot".into(), "p2".into(), q2, None);
    }

    #[test]
    #[should_panic(expected = "quote expired")]
    fn expired_quote_panics() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(RUNNER, RICH, NOW);
        let quote = make_quote_full(1_000, NOW - 1_000_000_000, "q1", &merchant_signer());
        e.request_payment("bot".into(), "p1".into(), quote, None);
    }

    #[test]
    #[should_panic(expected = "bad quote signature")]
    fn bad_quote_signature_panics() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(RUNNER, RICH, NOW);
        // Signed by the approval key, not the merchant's quote key.
        let quote = make_quote(1_000, &approval_signer());
        e.request_payment("bot".into(), "p1".into(), quote, None);
    }

    #[test]
    #[should_panic(expected = "vendor not allowlisted")]
    fn vendor_not_allowlisted_panics() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(RUNNER, RICH, NOW);
        let mut quote = make_quote(1_000, &merchant_signer());
        quote.recipient = acct("other.testnet");
        // Re-sign so the signature is valid for this recipient; the
        // allowlist check must still fire first.
        let payload = payload_of_quote(VAULT, &quote);
        quote.signature = Base64VecU8(merchant_signer().sign(&payload).to_bytes().to_vec());
        e.request_payment("bot".into(), "p1".into(), quote, None);
    }

    #[test]
    #[should_panic(expected = "caller not authorized")]
    fn unauthorized_caller_panics() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx("stranger.testnet", RICH, NOW);
        let quote = make_quote(1_000, &merchant_signer());
        e.request_payment("bot".into(), "p1".into(), quote, None);
    }

    #[test]
    #[should_panic(expected = "agent revoked")]
    fn revoked_agent_panics() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(OWNER, RICH, NOW);
        e.revoke_agent("bot".into(), Some("test".into()));
        set_ctx(RUNNER, RICH, NOW);
        let quote = make_quote(1_000, &merchant_signer());
        e.request_payment("bot".into(), "p1".into(), quote, None);
    }

    #[test]
    #[should_panic(expected = "engine paused")]
    fn paused_all_panics() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(OWNER, RICH, NOW);
        e.set_paused_all(true);
        set_ctx(RUNNER, RICH, NOW);
        let quote = make_quote(1_000, &merchant_signer());
        e.request_payment("bot".into(), "p1".into(), quote, None);
    }

    // ----- exception grants -----------------------------------------------------

    #[test]
    fn grant_happy_path_above_cap() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(RUNNER, RICH, NOW);
        let quote = make_quote(8_000, &merchant_signer());
        let grant = make_grant(10_000, "nonce-1", 1, &approval_signer());
        let status = e.request_payment("bot".into(), "p1".into(), quote, Some(grant));
        assert!(matches!(status, PaymentStatus::InFlight));
        assert_eq!(e.get_spent("bot".into(), TODAY), 8_000);
    }

    #[test]
    #[should_panic(expected = "grant amount exceeded")]
    fn grant_amount_exceeded_panics() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(RUNNER, RICH, NOW);
        let quote = make_quote(8_000, &merchant_signer());
        let grant = make_grant(7_000, "nonce-1", 1, &approval_signer());
        e.request_payment("bot".into(), "p1".into(), quote, Some(grant));
    }

    #[test]
    #[should_panic(expected = "grant already used")]
    fn grant_nonce_reuse_panics() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(RUNNER, RICH, NOW);
        let grant = make_grant(10_000, "nonce-1", 1, &approval_signer());
        let q1 = make_quote_full(8_000, EXPIRY, "q1", &merchant_signer());
        e.request_payment("bot".into(), "p1".into(), q1, Some(grant.clone()));
        let q2 = make_quote_full(8_000, EXPIRY, "q2", &merchant_signer());
        e.request_payment("bot".into(), "p2".into(), q2, Some(grant));
    }

    #[test]
    #[should_panic(expected = "grant policy version mismatch")]
    fn grant_policy_version_mismatch_panics() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(RUNNER, RICH, NOW);
        let quote = make_quote(8_000, &merchant_signer());
        let grant = make_grant(10_000, "nonce-1", 99, &approval_signer());
        e.request_payment("bot".into(), "p1".into(), quote, Some(grant));
    }

    #[test]
    #[should_panic(expected = "bad grant signature")]
    fn bad_grant_signature_panics() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(RUNNER, RICH, NOW);
        let quote = make_quote(8_000, &merchant_signer());
        // Signed by the merchant key, not the owner's approval key.
        let grant = make_grant(10_000, "nonce-1", 1, &merchant_signer());
        e.request_payment("bot".into(), "p1".into(), quote, Some(grant));
    }

    #[test]
    #[should_panic(expected = "exceptions paused")]
    fn exceptions_paused_blocks_grant_path() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(OWNER, RICH, NOW);
        e.set_paused_exceptions(true);
        assert_eq!(e.get_paused(), (true, false));
        set_ctx(RUNNER, RICH, NOW);
        let quote = make_quote(8_000, &merchant_signer());
        let grant = make_grant(10_000, "nonce-1", 1, &approval_signer());
        e.request_payment("bot".into(), "p1".into(), quote, Some(grant));
    }

    // ----- idempotency -----------------------------------------------------------

    #[test]
    fn idempotent_replay_returns_stored_status() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(RUNNER, RICH, NOW);
        let quote = make_quote(1_000, &merchant_signer());
        let first = e.request_payment("bot".into(), "p1".into(), quote.clone(), None);
        assert!(matches!(first, PaymentStatus::InFlight));
        let replay = e.request_payment("bot".into(), "p1".into(), quote.clone(), None);
        assert!(matches!(replay, PaymentStatus::InFlight));
        // No second charge: spent and counts unchanged.
        assert_eq!(e.get_spent("bot".into(), TODAY), 1_000);
        assert_eq!(e.get_payment_count(), 1);
        assert_eq!(e.get_total_in_flight(), 1_000);

        e.finalize_payment("p1", true);
        let replay = e.request_payment("bot".into(), "p1".into(), quote, None);
        assert!(matches!(replay, PaymentStatus::Succeeded));
    }

    #[test]
    #[should_panic(expected = "payment ID reused with different params")]
    fn replay_with_different_amount_panics() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(RUNNER, RICH, NOW);
        let q1 = make_quote(1_000, &merchant_signer());
        e.request_payment("bot".into(), "p1".into(), q1, None);
        let q2 = make_quote(2_000, &merchant_signer());
        e.request_payment("bot".into(), "p1".into(), q2, None);
    }

    // ----- recovery and withdraw ---------------------------------------------------

    #[test]
    fn recover_payment_finalizes_stuck_payment() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(RUNNER, RICH, NOW);
        let quote = make_quote(1_000, &merchant_signer());
        e.request_payment("bot".into(), "p1".into(), quote, None);
        set_ctx(OWNER, RICH, NOW);
        let status = e.recover_payment("p1".into(), false, "receipt:missing".into());
        assert!(matches!(status, PaymentStatus::Failed));
        assert_eq!(e.get_spent("bot".into(), TODAY), 0);
        assert_eq!(e.get_total_in_flight(), 0);
    }

    #[test]
    #[should_panic(expected = "withdraw exceeds available")]
    fn withdraw_cannot_eat_in_flight_funds() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(RUNNER, RICH, NOW);
        let quote = make_quote(1_000, &merchant_signer());
        e.request_payment("bot".into(), "p1".into(), quote, None);
        // Balance is now 5000 in context; 1000 is in flight and the mock
        // reports no storage usage, so only 4000 is available.
        set_ctx(OWNER, 5_000, NOW);
        e.withdraw(4_500);
    }

    #[test]
    fn withdraw_within_available_works() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(OWNER, RICH, NOW);
        e.withdraw(1_000_000);
    }

    // ----- admission against spendable balance ----------------------------

    #[test]
    #[should_panic(expected = "insufficient engine balance")]
    fn admission_counts_in_flight_against_balance() {
        let mut e = setup();
        register_bot(&mut e);
        // Balance 1000: a 700 payment fits and goes in flight.
        set_ctx(RUNNER, 1_000, NOW);
        let q1 = make_quote(700, &merchant_signer());
        e.request_payment("bot".into(), "p1".into(), q1, None);
        // Raw balance is still 1000 in context, but 700 is promised, so
        // only 300 is spendable and a 400 payment must not be admitted.
        let q2 = make_quote(400, &merchant_signer());
        e.request_payment("bot".into(), "p2".into(), q2, None);
    }

    // ----- the hold queue ---------------------------------------------------

    fn file_cap_hold(e: &mut Engine) {
        set_ctx(RUNNER, RICH, NOW);
        let quote = make_quote(6_000, &merchant_signer());
        let status = e.request_hold("h1".into(), "bot".into(), quote);
        assert!(matches!(status, HoldStatus::PendingApproval));
    }

    #[test]
    fn hold_files_for_cap_with_reason() {
        let mut e = setup();
        register_bot(&mut e);
        file_cap_hold(&mut e);
        let hold = e.get_hold("h1".into()).expect("hold stored");
        assert_eq!(hold.reason, "CAP");
        assert_eq!(hold.amount, 6_000);
        assert!(matches!(hold.status, HoldStatus::PendingApproval));
        // Refill with identical params is a status query, not an error.
        file_cap_hold(&mut e);
        assert_eq!(e.get_hold_count(), 1);
    }

    #[test]
    #[should_panic(expected = "payment within policy")]
    fn hold_rejects_payment_inside_policy() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(RUNNER, RICH, NOW);
        let quote = make_quote(100, &merchant_signer());
        e.request_hold("h1".into(), "bot".into(), quote);
    }

    #[test]
    fn hold_files_for_budget_after_spending() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(RUNNER, RICH, NOW);
        let q1 = make_quote(5_000, &merchant_signer());
        e.request_payment("bot".into(), "p1".into(), q1, None);
        let q2 = make_quote(1, &merchant_signer());
        e.request_payment("bot".into(), "p2".into(), q2, None);
        // Spent 5001 of the 10000 budget; 5000 fits the cap but not what
        // is left of the budget.
        let q3 = make_quote(5_000, &merchant_signer());
        let status = e.request_hold("h1".into(), "bot".into(), q3);
        assert!(matches!(status, HoldStatus::PendingApproval));
        assert_eq!(e.get_hold("h1".into()).unwrap().reason, "BUDGET");
    }

    #[test]
    #[should_panic(expected = "vendor not allowlisted")]
    fn hold_rejects_unknown_vendor() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(RUNNER, RICH, NOW);
        let mut quote = make_quote(6_000, &merchant_signer());
        quote.recipient = acct("stranger.testnet");
        e.request_hold("h1".into(), "bot".into(), quote);
    }

    #[test]
    #[should_panic(expected = "hold not approved")]
    fn execute_before_approve_panics() {
        let mut e = setup();
        register_bot(&mut e);
        file_cap_hold(&mut e);
        set_ctx(RUNNER, RICH, NOW);
        e.execute_hold("h1".into(), "p-h1".into());
    }

    #[test]
    fn approve_then_execute_settles_and_marks_hold() {
        let mut e = setup();
        register_bot(&mut e);
        file_cap_hold(&mut e);
        set_ctx(OWNER, RICH, NOW);
        let status = e.approve_hold("h1".into());
        assert!(matches!(status, HoldStatus::Approved));
        set_ctx(RUNNER, RICH, NOW);
        let status = e.execute_hold("h1".into(), "p-h1".into());
        assert!(matches!(status, PaymentStatus::InFlight));
        let hold = e.get_hold("h1".into()).unwrap();
        assert!(matches!(hold.status, HoldStatus::Executed));
        assert_eq!(hold.payment_id.as_deref(), Some("p-h1"));
        let payment = e.get_payment("p-h1".into()).unwrap();
        assert_eq!(payment.amount, 6_000);
        assert_eq!(e.get_spent("bot".into(), TODAY), 6_000);
    }

    #[test]
    #[should_panic(expected = "not owner")]
    fn approve_by_stranger_panics() {
        let mut e = setup();
        register_bot(&mut e);
        file_cap_hold(&mut e);
        set_ctx(RUNNER, RICH, NOW);
        e.approve_hold("h1".into());
    }

    #[test]
    #[should_panic(expected = "hold not pending")]
    fn approve_after_reject_panics() {
        let mut e = setup();
        register_bot(&mut e);
        file_cap_hold(&mut e);
        set_ctx(OWNER, RICH, NOW);
        let status = e.reject_hold("h1".into());
        assert!(matches!(status, HoldStatus::Rejected));
        e.approve_hold("h1".into());
    }

    #[test]
    fn hold_expires_after_ttl() {
        let mut e = setup();
        register_bot(&mut e);
        file_cap_hold(&mut e);
        set_ctx(OWNER, RICH, NOW + HOLD_TTL_NS + 1);
        let status = e.expire_hold("h1".into());
        assert!(matches!(status, HoldStatus::Expired));
    }

    #[test]
    #[should_panic(expected = "hold expired")]
    fn approve_after_expiry_panics() {
        let mut e = setup();
        register_bot(&mut e);
        file_cap_hold(&mut e);
        set_ctx(OWNER, RICH, NOW + HOLD_TTL_NS + 1);
        e.approve_hold("h1".into());
    }

    #[test]
    #[should_panic(expected = "daily budget exceeded")]
    fn execute_still_enforces_daily_budget() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(RUNNER, RICH, NOW);
        let q1 = make_quote(5_000, &merchant_signer());
        e.request_payment("bot".into(), "p1".into(), q1, None);
        let q2 = make_quote(1, &merchant_signer());
        e.request_payment("bot".into(), "p2".into(), q2, None);
        let q3 = make_quote(5_000, &merchant_signer());
        e.request_hold("h1".into(), "bot".into(), q3);
        set_ctx(OWNER, RICH, NOW);
        e.approve_hold("h1".into());
        // Approval waives the cap question, never the daily budget:
        // 5001 already spent, 5000 more would break the 10000 budget.
        set_ctx(RUNNER, RICH, NOW);
        e.execute_hold("h1".into(), "p-h1".into());
    }

    #[test]
    fn budget_hold_executes_after_budget_raise() {
        let mut e = setup();
        register_bot(&mut e);
        set_ctx(RUNNER, RICH, NOW);
        let q1 = make_quote(5_000, &merchant_signer());
        e.request_payment("bot".into(), "p1".into(), q1, None);
        let q2 = make_quote(1, &merchant_signer());
        e.request_payment("bot".into(), "p2".into(), q2, None);
        let q3 = make_quote(5_000, &merchant_signer());
        e.request_hold("h1".into(), "bot".into(), q3);
        set_ctx(OWNER, RICH, NOW);
        e.approve_hold("h1".into());
        e.update_agent_policy("bot".into(), None, Some(20_000), None);
        set_ctx(RUNNER, RICH, NOW);
        let status = e.execute_hold("h1".into(), "p-h1".into());
        assert!(matches!(status, PaymentStatus::InFlight));
    }
}
