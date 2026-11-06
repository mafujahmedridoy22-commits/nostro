# Invariants, and `doctor()`

nostro makes three promises about a tenant's records. Stores refuse writes that would break them,
but some states are reached by legal steps, and a database can be changed behind nostro's back.
`doctor()` checks all three and says what it found.

| | Promise | Who enforces it |
|---|---|---|
| **I1** | Every movement is fully allocated, partially allocated with an open exception covering the rest, carries an exception, or is ignored with a reason. Nothing is silently dropped. | every store, when a disposition is set; `doctor()` afterwards |
| **I2** | A watched account's recorded movements add up to the balance the chain reports for it. | `doctor()` with `attest`, or `attestBalances()` |
| **I3** | Every journal entry balances per asset, and a movement's entries agree with the movement. | every store, before posting; PostgreSQL again at COMMIT ([journal.md](./journal.md)); `doctor()` afterwards |

## Running it

From the command line, `nostro doctor` checks I1 and I3, and `nostro doctor --attest --account G...`
adds I2; it exits 1 if any invariant does not hold. From code:

```ts
import { HorizonBalanceSource, HorizonClient, HorizonEffectsSource, HorizonFeesSource, doctor } from 'nostro'

// I1 and I3 only: reads every movement and journal entry, writes nothing.
const report = await doctor({ store, tenantId: 'acme' })

// With I2: reads each account's balances from Horizon, catches the sources up, then compares.
const client = new HorizonClient({ url: 'https://horizon-testnet.stellar.org' })
const network = 'testnet'
const full = await doctor({
  store,
  tenantId: 'acme',
  attest: {
    balances: new HorizonBalanceSource({ client, network }),
    sources: [new HorizonEffectsSource({ client, network }), new HorizonFeesSource({ client, network })],
    accounts: ['G...'],
  },
})

full.ok // false if any finding is an error
full.findings // what is wrong, and where
full.balances // per account and asset: chain, recorded, the ledger compared at, match / mismatch / issuer
```

It reads the whole tenant, so run it as a batch job (nightly, or after a backfill), not per request.
It can run while ingest and reconcile are running: a movement that looks wrong is read again under
its lock before it is reported.

## Findings

| Code | Invariant | Severity | Means | What to do |
|---|---|---|---|---|
| `disposition_unsupported` | I1 | error | The disposition no longer matches the movement's allocations and exceptions. Typically a `partial` movement whose only exception was resolved. | Use `applyMovement()` for the rest, or `ignoreMovement()` ([docs/matching.md](./matching.md)). Those never leave a movement in this state; closing the exception directly can. |
| `allocation_asset` | I1 | error | An allocation is in a different asset from its movement. | Only possible by editing the database directly; investigate. |
| `allocation_over_movement` | I1 | error | Allocations add up to more than the movement. | As above. |
| `balance_mismatch` | I2 | error | The chain balance and the recorded movements disagree at the ledger the balance last changed in, after retries. | A source has missed something. Check that both the effects and fees sources run for the account, and that its history is within Horizon's retention. |
| `journal_unbalanced` | I3 | error | An entry's debits and credits differ in some asset. | SQLite cannot refuse this itself; someone wrote to the database directly. |
| `journal_posting_sequence` | I3 | error | A movement's posting numbers are not 1, 2, 3… | As above. |
| `journal_asset` | I3 | error | A line is in a different asset from its movement. | As above. |
| `journal_cash_mismatch` | I3 | error | A movement's cash lines net to something other than zero or its exact amount. | As above. |
| `journal_stale` | I3 | warning | The movement was decided, but the journal does not reflect the decision yet. | Run `postJournal()` (`nostro post`). `reconcile()` posts as it decides, so this follows decisions made by hand. |

Pending movements are not findings: they are the matching queue. The report counts them and gives
the date of the oldest.

## How the balance check works

Each balance is compared at the ledger it last changed in, using the `last_modified_ledger` Horizon
reports. The balance has been exactly that value ever since, so recorded movements up to and
including that ledger must add up to it, however busy the account is. The balances are read first and
the sources caught up afterwards. A mismatch is checked again about a ledger later, a few times,
before it is reported, in case a source answered from a Horizon server that was a moment behind.
[ADR 0008](./adr/0008-balance-attestation-at-a-ledger.md) has the reasoning.

Not covered yet:

- **Issuer accounts.** The chain shows no balance for an asset the account issues; those checks come
  back as `issuer` and attest nothing.
- **Liquidity pool shares** are skipped, as nostro does not record them as movements.
- **History Horizon no longer keeps.** Ingest from the start of an account's history needs Horizon to
  still have it (ADR 0006). For an older account the check will report a mismatch.

## In CI and against the real network

- Every captured Horizon fixture is ingested from each participant's side, reconciled and posted, and
  `doctor()` must find nothing (`packages/core/test/doctor.test.ts`).
- The shared store conformance suite runs `doctor()` alongside two reconcilers on every store.
- `node scripts/check-balances.mjs [--public] [--journal] <G...>` runs `doctor()` with `attest`
  against real accounts. On 2026-10-14 three testnet accounts with 3, 8,833 and 53,187 movements
  matched to the stroop in every asset, with every movement reconciled and posted, and the journal
  balanced.
- On 2026-10-16 the same three accounts, then holding 3, 9,427 and 53,740 movements, were synced,
  reconciled and checked with the CLI (`nostro sync`, `nostro reconcile`,
  `nostro doctor --attest`): every asset matched to the stroop, seven asset lines in all.
