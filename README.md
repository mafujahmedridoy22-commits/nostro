# nostro

[![CI](https://github.com/nostro-labs/nostro/actions/workflows/ci.yml/badge.svg)](https://github.com/nostro-labs/nostro/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

**Payment reconciliation and ledger-to-accounting infrastructure for Stellar.**

> **Status: `0.1.0`, early, and not yet on npm.** Implemented and tested: the `Money`/`Asset`
> core, the record model (movements, expectations, allocations, exceptions), the transactional
> `Store` contract with in-memory, SQLite (`nostro-store-sqlite`) and PostgreSQL
> (`nostro-store-postgres`) stores that pass one shared conformance suite, and Horizon ingestion
> (effects and fees) through a bounded `sync()` loop, matching through `reconcile()`, and a
> double-entry journal posted as movements are decided, with CSV export, `doctor()`, which checks
> all three invariants, a `nostro` command line over all of it (`nostro-cli`), and an HTTP API with
> signed webhooks (`nostro-server`, `nostro serve`), with an OpenAPI document and a container image.
> Nothing is on npm yet — see [Roadmap](#roadmap). Nothing here is production-ready yet, and this
> README marks what exists versus what doesn't.

## The problem

Every payments, payroll, escrow, subscription and invoicing product on Stellar has to answer one
question: *did this expected payment actually arrive, in full, from whom, and how do I record it?*

Almost everyone answers it like this:

```ts
server.payments().forAccount(ACCOUNT).stream({
  onmessage: (op) => {
    if (op.type === 'payment' && op.amount === invoice.amount) markInvoicePaid(invoice.id)
  },
})
```

That code is wrong in at least six ways, and every one of them is a real incident:

- `/payments` **never sees** a payment that arrived through a Soroban contract (SAC `transfer`),
  a claimable balance, or a trade. Those only appear on `/effects`.
- A dropped SSE reconnect silently loses events; nothing detects the gap.
- `op.amount` matching ignores the **issuer**, so a lookalike `USDC` from any issuer settles a real invoice.
- Partial payments, overpayments and duplicate deliveries all fall through.
- `amount` parsed as a `number` loses stroops above ~900M XLM and can't hold most 7-decimal values.
- A restart re-reads from an unknown cursor and re-applies effects that already committed.

nostro is the layer that gets this right once, so each product doesn't re-derive it badly.

## Ingesting an account (works today)

```ts
import { HorizonClient, HorizonEffectsSource, HorizonFeesSource, MemoryStore, sync } from 'nostro'

const client = new HorizonClient({ url: 'https://horizon-testnet.stellar.org' })
const store = new MemoryStore()
for (const source of [
  new HorizonEffectsSource({ client, network: 'testnet' }), // every credit, debit, trade, pool move
  new HorizonFeesSource({ client, network: 'testnet' }), //    fees are not effects; read them too
]) {
  const report = await sync({ store, source, tenantId: 'acme', accounts: ['G...'] })
  console.log(source.name, report.inserted, 'new movements', report.errors)
}
```

`sync()` is bounded and resumable: call it again to continue. The cursor advances in the same
transaction as the movements it covers, so a crash can never skip or double-apply a batch.

**Checked against the network.** `scripts/check-balances.mjs` ingests an account's whole history
and compares the per-asset sum of its movements with the balances Horizon reports. On 2026-10-06,
three testnet accounts matched to the stroop, including a DEX-trading account (6,674 movements
across four assets) and a Soroban bot account (50,875 movements). The rules that make that hold,
and two places where the obvious reading of Horizon is wrong, are in
[ADR 0006](./docs/adr/0006-normalising-horizon-effects.md).

## Reconciling against what you are owed (works today)

```ts
import { Money, NATIVE, reconcile } from 'nostro'

// Record what you are owed. A muxed id gives this invoice its own M... address.
await store.transaction((tx) =>
  tx.insertExpectation({
    tenantId: 'acme',
    reference: 'INV-1042',
    account: 'G...',
    amount: Money.parse('25', NATIVE),
    muxedId: 1042n,
  }),
)

// After sync(): decide every pending movement.
const report = await reconcile({ store, tenantId: 'acme' })
console.log(report.allocated, 'settled', report.exceptions) // e.g. 1 settled { AMBIGUOUS_MATCH: 2 }
```

Payments are matched by muxed id, memo id or text memo (normalised, so `inv #1042` finds `INV-1042`);
an amount alone is only ever a suggestion. Overpayments, duplicates, lookalike assets and late
payments are refused into an exceptions queue with the evidence for each decision. How decisions are
made, and what is not handled yet: [docs/matching.md](./docs/matching.md).

## Checking the books (works today)

```ts
import { doctor } from 'nostro'

const report = await doctor({ store, tenantId: 'acme' })
if (!report.ok) console.table(report.findings) // e.g. I1 disposition_unsupported on movement 3f2c…
```

`doctor()` checks every movement's disposition and every journal entry. Given `attest` (a Horizon
balance source, the movement sources and the accounts), it also compares each account's recorded
movements with its on-chain balance in every asset, as of the ledger that balance last changed in,
so an account that keeps transacting can still be checked exactly
([ADR 0008](./docs/adr/0008-balance-attestation-at-a-ledger.md)). Each finding and what to do about
it: [docs/invariants.md](./docs/invariants.md).

## From the command line (works today)

```sh
nostro migrate                                       # create ./nostro.db (or --db postgres://...)
nostro sync --account G...                           # ingest every effect and fee, until caught up
nostro expect INV-1042 --account G... --amount 25    # record what you are owed
nostro reconcile                                     # decide every pending movement, and post it
nostro exceptions                                    # what needs a person, and why
nostro doctor --attest --account G...                # check the books, and the balances on chain
nostro export --output journal.csv                   # the journal, a row per line
```

Each command exits non-zero when it fails or finds a problem, so it can run from cron or CI. Only
`migrate` changes the schema; every other command refuses a database that is not exactly at the
version it expects. On testnet, `nostro doctor --attest` matched three accounts with 3, 9,427
and 53,740 movements to the stroop in every asset. All the commands and options are in
[packages/cli](./packages/cli/README.md). It is not on npm yet: from a checkout, `pnpm build`, then
run `node packages/cli/dist/bin.js`.

## As a service (works today)

`nostro serve` runs the HTTP API ([packages/server](./packages/server/README.md), with an OpenAPI
document at `/v1/openapi.json`), keeps the watched accounts synced and reconciled, and posts each
decision to a URL as a signed webhook ([docs/webhooks.md](./docs/webhooks.md)). Events are written
in the same transaction as the decisions they announce, so a webhook never reports a payment that
rolled back, and none is lost to a crash. [examples/docker-compose](./examples/docker-compose) runs
it with PostgreSQL and a receiver that verifies every signature; the `Dockerfile` builds the image.

## What it does

```
SOURCE ──▶ INGEST ──▶ MATCH ──┬──▶ JOURNAL ──▶ EXPORT / EMIT
                              └──▶ EXCEPTIONS ──(resolve)──┘
```

Movements are normalised ledger facts; expectations are what you were owed; **allocations** link them
`(movement, expectation, amount)`, which is why partial payments, overpayments, split settlements and
one-wire-covers-six-invoices are all the same mechanism rather than six special cases.

## The invariant

The headline guarantee, checked in CI against every captured Horizon fixture, and at runtime by
`doctor()`:

> **I1 — total disposition.** Every movement is either fully allocated, partially allocated with an
> open exception covering the residual, carries at least one exception, or is explicitly ignored with
> a reason. **Nothing is ever silently dropped.**

Two more back it: **I2** cross-checks accumulated movements against the account's real on-chain
balance (this is what catches a source that quietly omitted events), and **I3** requires every
journal entry to balance per asset, `Σdebits = Σcredits`: every store checks it before writing,
PostgreSQL checks it again itself at COMMIT, and `doctor()` re-checks what is stored. See
[docs/invariants.md](./docs/invariants.md) and [docs/journal.md](./docs/journal.md).

## Non-goals

- **nostro never signs a transaction and never needs a secret key.** It observes and records. This is
  permanent, not a v1 limitation.
- Not a wallet, not a payment initiator, not an indexer-as-a-service.
- No floats. Ever. Amounts are integer raw units plus decimals; `Money` rejects `number` at runtime.

## Roadmap

| Version | Scope | State |
|---|---|---|
| 0.1 | Horizon ingestion, matching (muxed/memo/amount), exceptions, double-entry journal + CSV, invariants, CLI, server | in progress |
| 0.2 | Chart of accounts, accounting periods, QuickBooks / Xero / Beancount export | planned |
| 0.3 | Stellar RPC source for SEP-41 contract tokens, archive fallback, contract-address watching | planned |
| 0.4 | Exceptions UI, match hints, OpenTelemetry, anchor (SEP-24/31) awareness | planned |
| 0.5 | Hash-chained reconciliation attestations | planned |

## Prior art

[`stellar-payment-watcher`](https://www.npmjs.com/package/stellar-payment-watcher) wraps the payments
SSE stream (unmaintained, no matching or persistence). Stellar's
[Token Transfer Processor](https://developers.stellar.org/docs/data/indexers/build-your-own/processors/token-transfer-processor)
is the canonical event normaliser, but it is Go-only — nostro's `Movement` model deliberately mirrors
its vocabulary so the two stay interoperable.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Good first issues are labelled `good first issue`; the
matching engine is pure and fixture-tested, so you can add a strategy and prove it works offline in
under a minute.

## License

[Apache-2.0](./LICENSE)
