# nostro

**Payment reconciliation and ledger-to-accounting infrastructure for Stellar.**

Did this expected payment arrive, in full, from whom, and how do I record it? Most Stellar products
answer that with a Horizon `payments` stream and an amount comparison. That skips SAC transfers, never
sees claimable balances being claimed, ignores the asset issuer, misses what arrives while it is down,
and re-applies payments after a restart. nostro ingests every effect and fee, matches payments to what you are owed, posts a
double-entry journal, and checks its own books against the chain.

> **0.1.0, early.** Everything below is implemented and tested, and has been run against real
> testnet accounts, but the API may still change before 1.0. See the changelog for what is not
> handled yet.

```sh
npm install @nostro-labs/nostro
```

## Ingest an account

```ts
import { HorizonClient, HorizonEffectsSource, HorizonFeesSource, MemoryStore, sync } from '@nostro-labs/nostro'

const client = new HorizonClient({ url: 'https://horizon-testnet.stellar.org' })
const store = new MemoryStore() // or @nostro-labs/store-sqlite / @nostro-labs/store-postgres
for (const source of [
  new HorizonEffectsSource({ client, network: 'testnet' }), // every credit, debit, trade, pool move
  new HorizonFeesSource({ client, network: 'testnet' }), //    fees are not effects; read them too
]) {
  const report = await sync({ store, source, tenantId: 'acme', accounts: ['G...'] })
}
```

`sync()` is bounded and resumable. The cursor advances in the same transaction as the movements it
covers, so a crash can never skip or double-apply a batch.

## Reconcile against what you are owed

```ts
import { Money, NATIVE, reconcile } from '@nostro-labs/nostro'

await store.transaction((tx) =>
  tx.insertExpectation({ tenantId: 'acme', reference: 'INV-1042', account: 'G...', amount: Money.parse('25', NATIVE), muxedId: 1042n }),
)
const report = await reconcile({ store, tenantId: 'acme' })
```

Payments match by muxed id, memo id or text memo (normalised, so `inv #1042` finds `INV-1042`). An
amount alone is only ever a suggestion. Overpayments, duplicates, lookalike assets and late payments
go to an exceptions queue, with the evidence for each decision, and `applyMovement()` or
`ignoreMovement()` answer them. Every decision is posted to a
double-entry journal in the same transaction (`journalCsv()` exports it), and written to an event
log that `deliverWebhooks()` posts to a URL, signed (`verifyWebhook()` checks the signature).

## Check the books

```ts
import { doctor } from '@nostro-labs/nostro'

const report = await doctor({ store, tenantId: 'acme' }) // add `attest` to compare balances with the chain
```

- **I1:** every movement is allocated, partly allocated with an exception, raised as an exception,
  or ignored with a reason. Nothing is silently dropped.
- **I2:** each account's recorded movements add up to its on-chain balance in every asset.
- **I3:** every journal entry balances per asset.

## Money that cannot drift

```ts
Money.parse('0.1', NATIVE).add(Money.parse('0.2', NATIVE)).toString() // '0.3000000'
Money.parse('0.00000001', NATIVE) // throws PrecisionError: never rounded
```

Amounts are bigint raw units, never floats. Assets are `CODE:ISSUER`, so a lookalike `USDC` from
another issuer is a different asset and never settles a real invoice.

## The rest of nostro

- [`@nostro-labs/store-sqlite`](https://www.npmjs.com/package/@nostro-labs/store-sqlite) and
  [`@nostro-labs/store-postgres`](https://www.npmjs.com/package/@nostro-labs/store-postgres): durable stores
  that pass the same conformance suite as `MemoryStore`.
- [`@nostro-labs/cli`](https://www.npmjs.com/package/@nostro-labs/cli): `nostro sync`, `reconcile`, `doctor`,
  `export`, `serve` and more.
- [`@nostro-labs/server`](https://www.npmjs.com/package/@nostro-labs/server): the HTTP API, with an OpenAPI
  document.

nostro has no runtime dependencies. It runs on Node 22 or later.

**nostro never holds, requests or signs with a secret key.** It observes and records, and cannot move
funds. That is permanent, not a v1 limitation.

Documentation, design records and the changelog: **https://github.com/nostro-labs/nostro**

## License

Apache-2.0
