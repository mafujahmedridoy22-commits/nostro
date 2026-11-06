# Changelog

All five packages share a version. This project follows [Semantic Versioning](https://semver.org/);
before 1.0, a minor version may change the API.

## 0.1.0 (2026-11-06)

The first usable release: ingest a Stellar account, reconcile it against what you are owed, keep a
double-entry journal, check the books against the chain, and serve all of it over HTTP with signed
webhooks.

### `nostro`

- **Money and assets.** Exact bigint amounts that are never floats and never rounded. Assets are
  identified as `CODE:ISSUER`, so a lookalike issuer is a different asset.
- **Model and stores.** Movements, expectations, allocations, exceptions, journal entries and
  events. A transactional `Store` contract, with `MemoryStore` and a conformance suite every store
  must pass.
- **Ingestion.** `HorizonEffectsSource` and `HorizonFeesSource` read every credit, debit, trade,
  pool movement, SAC transfer and fee (fees are not effects). `sync()` is bounded and resumable, and
  advances its cursor in the same transaction as the movements it covers
  ([ADR 0005](./docs/adr/0005-cursor-in-transaction.md),
  [ADR 0006](./docs/adr/0006-normalising-horizon-effects.md)).
- **Matching.** `reconcile()` matches by muxed id, id memo and text memo (normalised). An amount
  alone is only ever a suggestion. Overpayments, duplicates, wrong assets, late payments and
  ambiguous matches become exceptions with evidence ([docs/matching.md](./docs/matching.md)).
- **Deciding by hand.** `applyMovement()`, `ignoreMovement()` and `closeException()`, or
  `decideException()` by reference, answer an exception. The movement, its exceptions and the
  journal change together, and what an application leaves over stays open.
- **Journal.** Double-entry, posted in the same transaction as each decision. Cash is posted once,
  and later changes are adjustment entries. The chart of accounts is configurable, and the journal
  exports to CSV ([docs/journal.md](./docs/journal.md),
  [ADR 0007](./docs/adr/0007-journal-adjustments.md)).
- **Invariants.** `doctor()` checks I1 (total disposition) and I3 (balanced journal). With `attest`
  it also checks I2: recorded movements against on-chain balances, per asset, at the ledger each
  balance last changed in ([docs/invariants.md](./docs/invariants.md),
  [ADR 0008](./docs/adr/0008-balance-attestation-at-a-ledger.md)).
- **Events and webhooks.** Every store writes an event in the same transaction as each decision.
  `deliverWebhooks()` posts them in order, signed with HMAC-SHA256, and `verifyWebhook()` checks
  the signature, with replay protection ([docs/webhooks.md](./docs/webhooks.md)).
- **JSON.** A JSON form for every record: amounts as decimal strings, uint64s as strings.

### `nostro-store-sqlite`, `nostro-store-postgres`

- Both pass the shared conformance suite and keep amounts exact beyond 64 bits.
- Only `migrate()` changes the schema. `schemaVersion()` reports where a database is, without
  changing it.
- PostgreSQL also checks journal balance itself, at commit. Writers serialise per tenant, so events
  commit in order.

### `nostro-server`

- An HTTP API: movements, expectations (list and create), exceptions (list and resolve), the
  journal (JSON and CSV), and the event log.
- Each API key belongs to a tenant. Keys are stored as hashes and compared in constant time.
- RFC 9457 problem details, and paging by `seq`. Request bodies containing JSON numbers are
  refused, because a number may already have been rounded by the time it is parsed.
- An OpenAPI 3.1 document at `/v1/openapi.json`, tested against real responses.

### `nostro-cli`

- `nostro migrate`, `sync`, `expect`, `expectations`, `reconcile`, `exceptions`, `resolve`, `post`,
  `doctor`, `export` and `serve`. `serve` runs the API, syncs and reconciles on an interval, and delivers
  webhooks. Exit codes suit cron and CI.
- A container image (`Dockerfile`) and a Docker Compose example with PostgreSQL and a webhook
  receiver.

### Examples

- `examples/before-after` runs a careful hand-rolled watcher and nostro over the same payments and
  scores both.

### Not handled yet

- **Refunds** are not linked to the payment they refund. A person can ignore both, with reasons.
- **Money paid into another of your own wallets** cannot be applied to an invoice on the wallet it
  should have gone to: allocations stay on one account.
- **Matching:** truncated text memos, `MEMO_HASH` references, known-payer corroboration, amount
  fingerprints, claimable-balance lifecycles, several payments in one transaction, path-payment
  slippage, and one payment covering several invoices with no per-invoice reference.
- **Balance attestation** does not cover issuer accounts or liquidity pool shares, nor history
  that Horizon no longer keeps.
- **Sources:** Horizon only. There is no Stellar RPC source, and no SEP-41 contract tokens.
- **Accounting:** generic CSV export only, with no accounting periods.
- `nostro serve` syncs one tenant's accounts. The API serves every tenant that has a key.
