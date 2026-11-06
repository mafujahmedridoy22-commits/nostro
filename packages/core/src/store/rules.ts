/**
 * The Store contract's rules, as pure functions.
 *
 * Every store applies these to rows it has read (and, in a SQL store, locked)
 * inside a transaction. Keeping them here means the memory and SQL stores
 * refuse exactly the same things with exactly the same errors; what differs
 * between stores is only how they make the reads safe from concurrent writers.
 */
import type {
  Allocation,
  Disposition,
  ExceptionRecord,
  Expectation,
  ExpectationStatus,
  JournalEntry,
  LineRole,
  Memo,
  Movement,
  NewAllocation,
  NewJournalEntry,
  NewMovement,
  Side,
} from '../model/index.js'
import { ValidationError, assertStorableText, signedAmount } from '../model/index.js'
import { Money, isSameCodeDifferentIssuer } from '../money/index.js'
import type { Resolution } from './store.js'
import { ConstraintError } from './store.js'

export function sumAmounts(amounts: readonly Money[], like: Money): Money {
  return amounts.reduce((acc, m) => acc.add(m), Money.zero(like.asset, like.decimals))
}

/**
 * A memo as every store keeps it. Half a character cannot be stored as text,
 * so it becomes U+FFFD, as Horizon does with bytes it cannot decode. It is not
 * refused: a memo is a fact from the chain, and refusing one would stop that
 * account's ingest for good.
 */
export function storedMemo(memo: Memo): Memo {
  return memo.type === 'text' ? { type: 'text', value: memo.value.replace(/\p{Cs}/gu, '\ufffd') } : memo
}

function sameMemo(a: Memo | null, b: Memo | null): boolean {
  if (a === null || b === null) return a === b
  const stored = storedMemo(b)
  return a.type === stored.type && a.value === stored.value
}

/** Whether a re-delivered movement states the same facts as the recorded one. */
export function sameFacts(existing: Movement, incoming: NewMovement): boolean {
  return (
    existing.account === incoming.account &&
    existing.direction === incoming.direction &&
    existing.kind === incoming.kind &&
    existing.amount.equals(incoming.amount) &&
    existing.counterparty === (incoming.counterparty ?? null) &&
    existing.muxedId === (incoming.muxedId ?? null) &&
    sameMemo(existing.memo, incoming.memo ?? null) &&
    existing.ledger === incoming.ledger &&
    existing.txHash === (incoming.txHash ?? null) &&
    existing.operationId === (incoming.operationId ?? null) &&
    existing.occurredAt.getTime() === incoming.occurredAt.getTime() &&
    existing.enrichment === (incoming.enrichment ?? 'complete')
  )
}

/**
 * Check an allocation against the movement and expectation it links and the
 * allocations already on each. Throws `ConstraintError`, or returns the
 * expectation's status once the allocation is applied.
 */
export function checkAllocation(
  allocation: NewAllocation,
  movement: Movement,
  expectation: Expectation,
  onMovement: readonly Allocation[],
  onExpectation: readonly Allocation[],
): ExpectationStatus {
  if (expectation.status === 'cancelled') {
    throw new ConstraintError('allocation_expectation_cancelled', `expectation ${expectation.id} is cancelled`)
  }
  for (const [label, other] of [
    ['movement', movement.amount],
    ['expectation', expectation.amount],
  ] as const) {
    if (allocation.amount.asset !== other.asset || allocation.amount.decimals !== other.decimals) {
      const lookalike = isSameCodeDifferentIssuer(allocation.amount.asset, other.asset)
        ? ' (same code, different issuer: a lookalike asset)'
        : ''
      throw new ConstraintError(
        'allocation_asset',
        `allocation is in ${allocation.amount.asset} but the ${label} is in ${other.asset}${lookalike}`,
      )
    }
  }
  if (movement.direction !== expectation.direction) {
    throw new ConstraintError(
      'allocation_direction',
      `a ${movement.direction} movement cannot settle a ${expectation.direction} expectation`,
    )
  }
  if (movement.account !== expectation.account) {
    throw new ConstraintError(
      'allocation_account',
      `money that moved on ${movement.account} cannot settle an expectation on ${expectation.account}`,
    )
  }
  if (onMovement.some((a) => a.expectationId === expectation.id)) {
    throw new ConstraintError(
      'allocation_unique',
      `movement ${movement.id} is already allocated to expectation ${expectation.id}`,
    )
  }
  const movementTotal = sumAmounts(onMovement.map((a) => a.amount), movement.amount).add(allocation.amount)
  if (movementTotal.compare(movement.amount) > 0) {
    throw new ConstraintError(
      'allocation_over_movement',
      `would allocate ${movementTotal.toString()} of a ${movement.amount.toString()} movement`,
    )
  }
  const expectationTotal = sumAmounts(onExpectation.map((a) => a.amount), expectation.amount).add(
    allocation.amount,
  )
  if (expectationTotal.compare(expectation.amount) > 0) {
    throw new ConstraintError(
      'allocation_over_expectation',
      `would allocate ${expectationTotal.toString()} against ${expectation.amount.toString()} expected`,
    )
  }
  return expectationTotal.equals(expectation.amount) ? 'settled' : 'partially_paid'
}

/** Check that a movement's allocations and exceptions support a disposition. */
export function checkDisposition(
  movement: Movement,
  allocations: readonly Allocation[],
  exceptions: readonly ExceptionRecord[],
  disposition: Disposition,
  reason?: string,
): void {
  const allocated = sumAmounts(allocations.map((a) => a.amount), movement.amount)
  const refuse = (why: string): never => {
    throw new ConstraintError(
      'disposition_unsupported',
      `cannot mark movement ${movement.id} ${disposition}: ${why}`,
    )
  }
  const totals = `allocations total ${allocated.toString()} of ${movement.amount.toString()}`
  switch (disposition) {
    case 'pending':
      if (!allocated.isZero()) refuse('it already has allocations')
      return
    case 'allocated':
      if (!allocated.equals(movement.amount)) refuse(totals)
      return
    case 'partial':
      if (allocated.isZero() || allocated.equals(movement.amount)) refuse(totals)
      if (!exceptions.some((e) => e.status === 'open')) {
        refuse('no open exception covers the unallocated residual')
      }
      return
    case 'exception':
      if (exceptions.length === 0) refuse('it has no exceptions')
      return
    case 'ignored':
      if (reason === undefined || reason.trim() === '') refuse('a reason is required')
      assertStorableText('reason', reason!)
      return
    default:
      throw new ValidationError('disposition', `unknown disposition ${JSON.stringify(disposition)}`)
  }
}

/** Check that an expectation can be cancelled. */
export function checkCancel(expectation: Expectation, reason: string): void {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new ValidationError('reason', 'must be a non-empty string')
  }
  assertStorableText('reason', reason)
  if (expectation.status === 'cancelled') {
    throw new ConstraintError('expectation_not_open', `expectation ${expectation.id} is already cancelled`)
  }
  if (expectation.status !== 'open') {
    throw new ConstraintError(
      'expectation_has_allocations',
      `expectation ${expectation.id} is ${expectation.status}; reverse its allocations before cancelling`,
    )
  }
}

/** Check that an exception can take this resolution. */
export function checkResolution(exception: ExceptionRecord, resolution: Resolution): void {
  if (resolution.status !== 'resolved' && resolution.status !== 'dismissed') {
    throw new ValidationError('status', 'must be "resolved" or "dismissed"')
  }
  if (typeof resolution.note !== 'string' || resolution.note.trim() === '') {
    throw new ValidationError('note', 'must be a non-empty string')
  }
  assertStorableText('note', resolution.note)
  if (exception.status !== 'open') {
    throw new ConstraintError('exception_not_open', `exception ${exception.id} is already ${exception.status}`)
  }
}

/** Check a cursor value before it is stored. */
export function checkCursorValue(value: string): void {
  if (typeof value !== 'string' || value === '') {
    throw new ValidationError('cursor', 'must be a non-empty string')
  }
  assertStorableText('cursor', value)
}

/** Roles whose lines are the movement's own balance: a wallet's cash, or an issuer's issued supply. */
const BALANCE_ROLES: ReadonlySet<LineRole> = new Set(['cash', 'issued'])

/** A line's amount as a debit-positive bigint. */
const signed = (side: Side, raw: bigint): bigint => (side === 'debit' ? raw : -raw)

/**
 * Check a journal entry against the movement it accounts for and the
 * movement's earlier entries. Throws `ConstraintError`.
 *
 * - every asset balances on its own (I3); totals across assets mean nothing
 * - `postingNo` is exactly one past the movement's last entry, so two
 *   concurrent posters cannot both append
 * - lines are in the movement's asset
 * - after this entry the movement's cash leg nets to zero or to exactly the
 *   movement's signed amount, so the journal's cash can never drift from
 *   the chain (I2)
 */
export function checkJournalEntry(
  entry: NewJournalEntry,
  movement: Movement | null,
  existing: readonly JournalEntry[],
): void {
  const net = new Map<string, bigint>()
  for (const line of entry.lines) {
    const key = `${line.amount.asset}/${line.amount.decimals}`
    net.set(key, (net.get(key) ?? 0n) + signed(line.side, line.amount.raw))
  }
  for (const [key, total] of net) {
    if (total !== 0n) {
      throw new ConstraintError('journal_unbalanced', `${key.split('/')[0]} is out by ${total} raw units`)
    }
  }
  if (movement === null) return

  const expected = existing.length + 1
  if (entry.postingNo !== expected) {
    throw new ConstraintError(
      'journal_posting_conflict',
      `movement ${movement.id} has ${existing.length} entries, so the next is posting ${expected}, not ${entry.postingNo}`,
    )
  }
  for (const line of entry.lines) {
    if (line.amount.asset !== movement.amount.asset || line.amount.decimals !== movement.amount.decimals) {
      throw new ConstraintError(
        'journal_asset',
        `a line in ${line.amount.asset} cannot account for a movement in ${movement.amount.asset}`,
      )
    }
  }
  let cash = 0n
  for (const line of [...existing.flatMap((e) => e.lines), ...entry.lines]) {
    if (BALANCE_ROLES.has(line.role)) cash += signed(line.side, line.amount.raw)
  }
  const target = signedAmount(movement).raw
  if (cash !== 0n && cash !== target) {
    throw new ConstraintError(
      'journal_cash_mismatch',
      `movement ${movement.id}'s cash leg would net to ${cash}, but the movement is ${target}`,
    )
  }
}
