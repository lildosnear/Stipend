# Stipend

**Give your agent a stipend, not your wallet.**

Stipend is an SDK and on chain policy engine that any agent wallet or AI application can integrate. You set a stipend for each agent: a cap per payment, a budget per day, and a list of approved vendors. Payments inside the stipend settle on their own. Anything outside it is blocked, or held for the owner to approve. The limits are enforced by a smart contract on NEAR, not by instructions given to the agent, so a prompt or a poisoned tool response cannot talk its way past them.

Built at NEAR Hackathon 2026 (AI Security & Defense, Agent Economy). Status: version one, NEAR testnet.

**Live on NEAR testnet:** the policy engine is deployed at `stipend.testnet`, with a demo agent (cap 0.05 NEAR per payment, budget 1 NEAR per day) buying from a test seller. Every flow described below has been run against it end to end: normal buys settle and deliver, an over cap buy is held and then settled after an owner signed approval, and expired quotes, forged prices, and unknown vendors are all blocked with their reasons.

## Why

Agents are starting to hold real spending power, and the usual protection is a written instruction: do not overspend, do not pay strangers. Instructions fail. Stipend moves the protection into a contract that checks every payment before any money moves: who is paying, who is being paid, how much, and whether it fits the stipend the owner set.

## How it works

1. The owner opens a stipend for an agent in the policy engine contract: cap per payment, budget per day, approved vendors.
2. A vendor prices a resource and signs a quote, so an agent cannot invent a price.
3. The agent pays through the SDK. The contract checks the payment against the stipend before settling it.
4. A payment outside the stipend is blocked, or held in an approvals queue. The owner can approve a held payment once with a signed grant.
5. The owner can pause all payments or revoke an agent at any time. Every decision, allowed or blocked, is recorded.

## Integrate it

Agent side, in an AI application:

```ts
import { createStipendClient } from "@stipend/sdk";

const stipend = createStipendClient({
  contractId: "engine.stipend.testnet",
  agentId: "research-agent",
  signer, // an authorized caller for the agent
});

// Pays for a priced resource. Throws a typed error if the
// payment is blocked, or returns a hold id if it needs approval.
const { receipt, delivery } = await stipend.purchase("data:market-report");
```

App side, in an API or agent wallet that sells to agents:

```ts
import { stipendSeller } from "@stipend/sdk";

// Wrap a priced resource. Buyers pay through their stipend;
// settlement only happens after the policy engine approves it.
app.get("/resource/data:market-report", stipendSeller({
  price: "1000000000000000000000", // 0.001 NEAR
  sellerKey, // signs quotes buyers submit to the engine
}));
```

Owner calls (set a stipend, list holds, approve, pause, revoke) are in the same SDK.

## Repository layout

- `contracts/policy-engine` — the on chain policy engine (Rust, NEAR).
- `packages/sdk` — the TypeScript SDK: agent client, seller helper, owner calls.
- `apps/reference-app` — a sample AI application integrated with the SDK, end to end.
- `apps/console` — a small owner console: stipends, holds queue, blocked attempts log. A demo surface over the SDK.

## Running the demo

### Prerequisites

Node 20 or newer. Rust with the `wasm32-unknown-unknown` target is needed only if you rebuild the contract; the demo can use the prebuilt wasm that ships in this repo under `contracts/policy-engine/target/` instead. Deploying needs a funded NEAR testnet payer account holding at least 7 test NEAR, with its key file at the path in `STIPEND_PAYER_KEY_PATH`, or at `~/.nyx-keys/payer.testnet.json` by default.

Install and build everything first (the reference app and console run from `dist/`, so the build has to come before any demo command):

```sh
npm install
npm run build
```

Build the contract (the build script sets a compiler flag the NEAR libraries need; without it, contract rejections lose their reason text on chain). Skip this step if you use the prebuilt wasm that ships in this repo:

```sh
scripts/build-contract.sh
```

Deploy to testnet. This creates the engine and seller accounts under your funded testnet payer account, deploys the engine, and registers a demo agent called bot with a 0.05 NEAR cap per payment and a 1 NEAR budget per day. Account ids and public keys land in `keys/deploy-info.json`:

```sh
node scripts/deploy-testnet.mjs
```

The `<engine>` and `<seller>` values in the commands below are the account ids from `keys/deploy-info.json`, and the key files in `keys/` are named by account id.

Run the seller and the demo agent:

```sh
cd apps/reference-app
STIPEND_CONTRACT_ID=<engine> SELLER_ACCOUNT_ID=<seller> \
SELLER_KEY_PATH=../../keys/<seller>.json \
SELLER_QUOTE_PRIV_PATH=../../keys/stipend-seller-quote.priv.b64 \
AGENT_ACCOUNT_ID=<engine> AGENT_KEY_PATH=../../keys/<engine>.json \
npm run seller   # in one terminal
npm run agent    # in another: three small buys settle, the 0.08 NEAR buy is held at the cap
npm run attacks  # expired quote, forged price, unknown vendor: all blocked, each with its reason
```

Run the owner console and approve the held payment from the Holds page:

```sh
cd apps/console
STIPEND_CONTRACT_ID=<engine> STIPEND_OWNER_ACCOUNT_ID=<engine> \
STIPEND_OWNER_KEY_PATH=../../keys/<engine>.json \
STIPEND_APPROVAL_PRIV_PATH=../../keys/stipend-approval.priv.b64 \
npm start        # http://localhost:8282
```

### If you only want to check the SDK

No deploy needed. From the repo root:

```sh
npm install
npm run build
npm test   # 13 of 13, covering signing, amount handling, and a full purchase flow
```

## Roadmap (not in version one)

Mainnet, confidential settlement through NEAR Intents, other chains, a hosted service, teams and multiple owners, assets beyond NEAR.
