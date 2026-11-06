# Matching

`reconcile()` takes movements still `pending` after `sync()` and decides each one with a pure
function, `decide(movement, candidates, options)`. Same inputs, same decision: no I/O, no clock, no
randomness, and every decision records its reasons as evidence.

## How a decision is made

1. **Fees are never matched.** They are ignored with a reason and belong to the journal as expense.
2. **Every strategy scores every candidate.** Candidates are the account's open and part-paid
   expectations in the same direction, plus any expectation whose muxed id the movement carries.
3. **Scores combine by family.** Within a family only the strongest signal counts; across families
   they combine as `1 − Π(1 − sᵢ)`. A muxed id and a memo both identify the expectation, so finding
   both is not twice the evidence. A memo plus a unique amount is.
4. **A match needs confidence and a clear winner:** a combined score of at least **0.70** and a lead
   of at least **0.15** over the runner-up. Anything else goes to a person as `AMBIGUOUS_MATCH`, with
   every candidate's signals attached.
5. **A confident match can still be refused** (see below).
6. **Otherwise allocate** `min(amount, remaining)`. Anything left over is an overpayment.

## Strategies

| Strategy | Family | Score | Fires when | False-positive risk |
|---|---|---|---|---|
| `muxed_id` | identifier | 1.00 | paid to the `M…` address issued for the expectation | none if ids are issued uniquely |
| `memo_id` | identifier | 0.95 | `MEMO_ID` equals the memo id asked for, or the expectation's muxed id | payer typo or a reused old invoice id |
| `memo_hash` | identifier | 0.95 | `MEMO_HASH` equals the hash asked for | none; hashes are opaque and compared exactly |
| `memo_text` | identifier | 0.85 | normalised text memo equals the normalised reference or requested memo | normalisation is deliberately loose |
| `exact_amount` | amount | 0.60 unique / 0.20 shared | exactly the amount still owed, same asset, inside the window | any two invoices for the same amount |

**An amount alone never settles anything:** 0.60 is below the 0.70 threshold, so a unique-amount match
without a memo becomes a suggestion in the exceptions queue. Lowering `threshold` changes that, and
should be a deliberate decision.

Text memos are normalised before comparison (NFKC, zero-width and control characters removed,
upper-cased, `INVOICE` / `INV` / `REF` / `NO` / `#` prefixes dropped at a word boundary, separators
dropped). `INV-00123`, `inv #00123`, `Invoice 00123` and `ＩＮＶ００１２３` are the same reference;
`INVENTORY-5` keeps its word, and `00123` is not `123`.

To add a strategy, see [CONTRIBUTING](../CONTRIBUTING.md#adding-a-matching-strategy).

## Outcomes

| Situation | Disposition | Exception |
|---|---|---|
| Matched, paid in full or in part | `allocated` | none |
| Matched, paid more than was owed | `partial` | `OVERPAYMENT` for the residual |
| Matched an expectation with nothing left owing | `exception` | `DUPLICATE_PAYMENT` |
| Matched, but in another asset (incl. same code, other issuer) | `exception` | `WRONG_ASSET` |
| Matched, but paid after the expectation expired | `exception` | `LATE_BEYOND_WINDOW` |
| Best candidate below 0.70, or two within 0.15 | `exception` | `AMBIGUOUS_MATCH` |
| Credit with no memo or muxed id, while something is owed | `exception` | `MEMO_MISSING` |
| Credit with no memo or muxed id, nothing owed | `exception` | `UNEXPECTED_CREDIT` |
| Credit whose memo or muxed id matches nothing | `exception` | `UNMATCHED_NO_CANDIDATE` |
| Credit whose source enrichment is missing | `exception` | `ENRICHMENT_MISSING` |
| Debit that matches no payout | `exception` | `UNEXPECTED_DEBIT` |
| Network fee | `ignored` | none |

Every case above has a test in `packages/core/test/matching.test.ts` or `reconcile.test.ts`.

## When a person decides

An exception is a question for a person. These answer it, each in one transaction with the journal
adjustment it causes, and every event it means:

```ts
import { applyMovement, closeException, ignoreMovement } from '@nostro-labs/nostro'

// "That payment was for INV-1042." Applied by hand, it takes what is left of the movement and still
// owing, unless you give an amount; several expectations split it.
await applyMovement({ store, tenantId, movementId, allocations: [{ expectationId }], note: 'customer called' })

// "That is not something to reconcile." Whatever was already allocated stays allocated.
await ignoreMovement({ store, tenantId, movementId, reason: 'our own top-up' })

// For an exception no movement depends on.
await closeException({ store, tenantId, exceptionId, status: 'dismissed', note: 'checked' })
```

| What the person decides | Disposition after | Journal adjustment (reclass, cash untouched) |
|---|---|---|
| A payment with no match was for an invoice | `allocated` | Dr unapplied · Cr receivable |
| It was only partly for one | `partial`, with `PARTIAL_UNRESOLVED` for exactly what is left | Dr unapplied · Cr receivable, for the part applied |
| An overpayment's residual goes to another invoice | `allocated`, or `partial` with `OVERPAYMENT` for what is left | Dr customer credit · Cr receivable |
| Money in that is not to be reconciled | `ignored`, with the reason | Dr unapplied · Cr uncategorized income |
| Money out that is not to be reconciled | `ignored`, with the reason | Dr uncategorized expense · Cr suspense |
| An overpayment is kept | `ignored`; the invoice stays settled | Dr customer credit · Cr uncategorized income |

The rules hold for a person too: a lookalike asset cannot settle an invoice, money on one account
cannot settle an invoice on another, nothing can be over-allocated, and a cancelled invoice cannot be
paid. An invoice past its expiry can, because deciding that is what the person is there for. A
movement with nothing left to decide is refused with `movement_not_open`, which is also what the
second of two people deciding at once receives.

Closing the last open exception of an undecided movement is refused, because it would leave the
movement's disposition with nothing to support it (I1). Apply or ignore the movement instead.

## Not handled yet

These are known gaps, each planned as its own self-contained piece of work:

- **Truncated text memos.** A reference longer than 28 bytes of UTF-8 is cut by the wallet; nostro does
  not yet detect truncation or prefix-match it.
- **Known-payer corroboration**, scoring a payment from an account registered as the payer.
- **Amount fingerprints**, a unique sub-unit suffix per invoice for payers who cannot send memos.
- **Claimable balances** as a two-step create-then-claim lifecycle.
- **Several payments in one transaction** sharing a memo.
- **Slippage tolerance** for path payments delivering slightly less than asked.
- **One payment covering several invoices** with no per-invoice reference. Today this is an
  exception for a person to split.
- **A second payment quoting a settled invoice's text reference** is raised as
  `UNMATCHED_NO_CANDIDATE` rather than `DUPLICATE_PAYMENT`: settled expectations are only found again
  through a muxed id.
