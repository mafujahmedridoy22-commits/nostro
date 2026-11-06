# The journal

nostro turns every decided movement into double-entry journal entries. `reconcile()` posts them in the
same transaction as each decision; `postJournal()` sweeps anything decided another way (by hand,
or before the journal existed). Running either again posts nothing new.

## Accounts

Every line has a role. The chart of accounts maps roles to account codes; pass your own to
`reconcile({ chart })` or `postJournal({ chart })`.

| Role | Default account | Posted when |
|---|---|---|
| `cash` | `assets:stellar:<network>:<G...>` | every movement on a wallet, for its full amount |
| `issued` | `liabilities:issued` | instead of cash, when the watched account issues the asset |
| `receivable` | `assets:receivable` | an incoming payment is applied to an expectation |
| `payable` | `liabilities:payable` | an outgoing payment is applied to a payout |
| `customer_credit` | `liabilities:customer-credit` | overpaid, or paid twice: owed back to a known payer |
| `unapplied` | `liabilities:unapplied-receipts` | money in that nobody has explained yet |
| `unexplained` | `assets:suspense` | money out that nobody has explained yet |
| `network_fees` | `expenses:network-fees` | transaction fees |
| `uncategorized_income` | `income:uncategorized` | an incoming movement deliberately ignored |
| `uncategorized_expense` | `expenses:uncategorized` | an outgoing movement deliberately ignored |

Unexplained money out is a suspense *asset*, not a liability: it was usually exchanged for something
(a DEX trade, a bill booked elsewhere), and sharing an account with unexplained receipts would let
unrelated flows cancel out.

**`receivable` runs a credit balance inside nostro.** nostro does not book your invoices; your
accounting system does. nostro's receivable lines are the payment side of that receivable, linked to
each invoice by its expectation, so an exporter can match them up. The same goes for `payable`.

## Examples

| What happened | Entry |
|---|---|
| 25 USDC paid INV-2 in full | Dr cash 25 · Cr receivable 25 (INV-2) |
| 30 USDC paid INV-2 (25 owed) | Dr cash 30 · Cr receivable 25 (INV-2) · Cr customer credit 5 |
| 7 USDC arrived with no memo | Dr cash 7 · Cr unapplied 7 |
| 0.00001 XLM network fee | Dr network fees · Cr cash |
| Later, a person applies the 7 USDC to INV-3 | **reclass:** Dr unapplied 7 · Cr receivable 7 (INV-3) |

## Entries are adjusted, never edited

Cash is posted once. When a decision changes later, nostro posts only the difference between how the
movement should now be accounted for and how it already is ([ADR 0007](./adr/0007-journal-adjustments.md)):

- **initial** — dated when the money moved;
- **reclass** — cash untouched; dated when posted, because applying cash happens when it is applied;
- **correction** — changes the cash leg (a source correction); dated like the original.

## Guarantees, and who enforces them

| Guarantee | Every store (shared rule, before writing) | PostgreSQL itself | SQLite itself |
|---|---|---|---|
| Each entry balances per asset (I3) | yes | yes, at COMMIT (deferred trigger) | no: amounts beyond 64 bits are text it cannot sum |
| Entries are never edited or deleted | yes | yes (triggers) | yes (triggers) |
| One entry per posting number per movement | yes (compare-and-set) | yes (unique index) | yes (unique index) |
| A movement's cash nets to 0 or its exact amount | yes | no | no |

## Export

```ts
import { journalCsv, journalCsvRows } from '@nostro-labs/nostro'

const october = await journalCsv({ store, tenantId: 'acme', from: new Date('2026-10-01'), to: new Date('2026-11-01') })
for await (const row of journalCsvRows({ store, tenantId: 'acme' })) process.stdout.write(row) // streams
```

One row per journal line, RFC 4180 with CRLF line endings. Columns: `entry_id`, `seq`, `kind`,
`posted_at`, `effective_at`, `description`, `line_no`, `account`, `role`, `asset`, `debit`, `credit`,
`movement_id`, `tx_hash`, `expectation_reference`, `exception_id`, `exception_code`.

- Amounts are exact decimal strings, never floats, even beyond 64 bits.
- `from` / `to` select by effective date: `from` inclusive, `to` exclusive.
- Text that a spreadsheet would run as a formula (starting with `=`, `+`, `-`, `@` or a tab) is
  prefixed with `'`. References and account codes come from users, and these files get opened in
  spreadsheets. Payment memo text, which the payer controls, is never written.

## Checked against the network

`node scripts/check-balances.mjs --journal <G…>` ingests an account's whole history, reconciles it
(posting the journal), and checks per asset that the journal's cash for the account equals the
Horizon balance, that debits equal credits, and that running everything again posts nothing.

## Not handled yet

- Rules that pick accounts per counterparty, asset or expectation (the chart maps roles only).
- Accounting periods and soft close. Entries are dated so they can be added without schema changes.
- Exporters for QuickBooks, Xero and Beancount. Today there is the generic CSV above.
