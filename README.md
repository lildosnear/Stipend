# Stipend

**Give your agent a stipend, not your wallet.**

Stipend is an SDK and on chain policy engine that any agent wallet or AI application can integrate. You set a stipend for each agent: a cap per payment, a budget per day, and a list of approved vendors. Payments inside the stipend settle on their own. Anything outside it is blocked, or held for the owner to approve. The limits are enforced by a smart contract on NEAR, not by instructions given to the agent, so a prompt or a poisoned tool response cannot talk its way past them.

Built at NEAR Hackathon 2026 (AI Security & Defense, Agent Economy). Status: version one, NEAR testnet.

**Live on NEAR testnet:** the policy engine is deployed at `stipend.testnet`, with a demo agent (cap 0.05 NEAR per payment, budget 1 NEAR per day) buying from a test seller. Every flow described below has been run against it end to end: normal buys settle and deliver, an over cap buy is filed as an on chain hold and settles after the owner approves it in the queue, and expired quotes, forged prices, and unknown vendors are all blocked with their reasons.

## Why

Agents are starting to hold real spending power, and the usual protection is a written instruction: do not overspend, do not pay strangers. Instructions fail. Stipend moves the protection into a contract that checks every payment before any money moves: who is paying, who is being paid, how much, and whether it fits the stipend the owner set.

## How it works

1. The owner opens a stipend for an agent in the policy engine contract: cap per payment, budget per day, approved vendors.
2. A vendor prices a resource and signs a quote, so an agent cannot invent a price.
3. The agent pays through the SDK. The contract checks the payment against the stipend before settling it.
4. A payment that breaks only a policy limit, the cap or the daily budget, is filed as a hold in the engine's on chain approval queue, with a lifecycle: PendingApproval, then Approved and Executed, or Rejected, or Expired after 24 hours. The owner decides on chain; approval waives the cap for that payment, and the daily budget is checked again when the money moves. Anything else, an unknown vendor, a bad signature, an expired quote, is blocked outright and recorded.
5. The owner can pause all payments or revoke an agent at any time. Every decision, allowed or blocked, is recorded.

## Integrate it

Agent side, in an AI application:

```ts
import { AttemptLog, EngineClient, createStipendClient } from "@stipend/sdk";

// One engine client: it talks to the policy engine contract and signs
// calls with an account the agent's stipend authorizes.
const engine = new EngineClient({
  networkId: "testnet",
  nodeUrl: "https://rpc.testnet.near.org",
  contractId: "stipend.testnet",
  accountId: "caller.testnet", // an authorized caller for the agent
  privateKey: "ed25519:<the caller account key>",
});

const stipend = createStipendClient({
  engine,
  agentId: "bot",
  sellerBaseUrl: "http://localhost:8787",
  attemptLog: new AttemptLog("data/attempts.json"), // optional: records blocked attempts for the owner
});

// Pays for a priced resource and returns the on chain receipt and the
// delivered content. If the engine blocks the payment, this throws a
// StipendError with a typed code (CAP, BUDGET, VENDOR, EXPIRED, and
// friends), and the blocked attempt lands in the attempt log.
const { receipt, delivery } = await stipend.purchase("data:market-report");
```

Seller side, in an API that sells to agents (`engine` is an EngineClient like the one above; any signer works, the seller only reads the engine):

```ts
import { createSellerApp } from "@stipend/sdk";

const seller = createSellerApp({
  engine,
  contractId: "stipend.testnet",
  sellerAccountId: "seller.testnet", // receives the payments
  quotePrivateKeyBase64: "<base64 seed of the quote key registered in agents' allowlists>",
  priceTable: {
    "data:market-report": { amount: 1000000000000000000000n, asset: "NEAR" }, // 0.001 NEAR
  },
  deliver: (resource) => ({ resource, headline: "NEAR holds its range" }),
});

seller.listen(8787); // serves /vault-quote, /pay and /deliver
```

The seller signs a quote for each resource. A buyer agent submits the quote to the engine, the engine checks the buyer's stipend and settles, and only then does the seller deliver.

Owner side, the same SDK (`engine` must be signed by the engine owner account):

```ts
import { createOwnerTools } from "@stipend/sdk";

const owner = createOwnerTools({
  engine,
  contractId: "stipend.testnet",
  approvalPrivateKeyBase64: "<base64 seed of the approval key registered in the engine>",
});

await owner.setStipend({
  agentId: "bot",
  perPaymentCap: "50000000000000000000000", // 0.05 NEAR, yocto as a string
  dailyBudget: "1000000000000000000000000", // 1 NEAR
  authorizedCallers: ["caller.testnet"],
  allowlist: [{ account: "seller.testnet", quote_key: "<base64 quote key>", label: "Test data API" }],
});

// The on chain holds queue: list, approve (decision plus execution),
// reject. Approving settles the held payment under a fresh payment id.
// await owner.listHolds();
// await owner.approveHold(holdId);
// await owner.rejectHold(holdId);
// A one off signed grant path also exists: owner.approvePayment(...)
// settles a single payment directly, without the queue.
// The owner can also pauseAll(), resumeAll(), revoke(agentId) and
// reactivate(agentId). Blocked attempts are read from the attempt log
// (see the owner console in apps/console for a working holds queue).
```

## Repository layout

- `contracts/policy-engine` — the on chain policy engine (Rust, NEAR).
- `packages/sdk` — the TypeScript SDK: agent client, seller helper, owner calls.
- `apps/reference-app` — a sample AI application integrated with the SDK, end to end.
- `apps/console` — a small owner console: stipends, the on chain holds queue, blocked attempts log. Admin actions require an owner token (printed once in the server startup log, or set STIPEND_CONSOLE_TOKEN), and the server binds localhost unless CONSOLE_HOST says otherwise.

## Running the demo

### Prerequisites

Node 20 or newer. Rust with the `wasm32-unknown-unknown` target is needed only if you rebuild the contract; the demo can use the prebuilt wasm that ships in this repo under `contracts/policy-engine/target/` instead. Deploying needs a funded NEAR testnet payer account holding at least 7 test NEAR, with its key file at the path in `STIPEND_PAYER_KEY_PATH`, or at `~/.stipend-keys/payer.testnet.json` by default.

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
npm run agent    # in another: three small buys settle, the 0.08 NEAR buy is held at the cap and filed on chain
npm run attacks  # expired quote, forged price, unknown vendor: all blocked, each with its reason
```

Run the owner console and approve the held payment from the Holds page. The server prints an owner token at startup; the page asks for it the first time you approve, pause, or revoke:

```sh
cd apps/console
STIPEND_CONTRACT_ID=<engine> STIPEND_OWNER_ACCOUNT_ID=<engine> \
STIPEND_OWNER_KEY_PATH=../../keys/<engine>.json \
STIPEND_APPROVAL_PRIV_PATH=../../keys/stipend-approval.priv.b64 \
npm start        # http://localhost:8282
```

To only look at a live engine, set just the contract id and start
the console: without the owner key files it runs read only, every
page works from chain views, and admin actions are refused. The
owner key is never shared with the code, so this read only mode is
how anyone checks a deployed engine from a plain checkout.

### If you only want to check the SDK

No deploy needed. From the repo root:

```sh
npm install
npm run build
npm test   # 15 of 15, covering signing, amount handling, a full purchase flow, and the seller quote binding
```

## Roadmap (not in version one)

Mainnet, confidential settlement through NEAR Intents, other chains, a hosted service, teams and multiple owners, assets beyond NEAR.
