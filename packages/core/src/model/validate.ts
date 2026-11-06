/**
 * Structural validation for records entering a store.
 *
 * This rejects only what cannot be true of a real ledger fact: a negative
 * amount, a malformed transaction hash, a muxed id outside uint64. It never
 * rejects data merely for being unusual — a rejected movement is a dropped
 * movement, and invariant I1 forbids dropping anything. Odd-but-possible data
 * is ingested and left for matching to raise as an exception.
 */
import type {
  Memo,
  NewAllocation,
  NewException,
  NewExpectation,
  NewJournalEntry,
  NewMovement,
} from './types.js'
import { EXCEPTION_CODES, JOURNAL_ENTRY_KINDS, LINE_ROLES, MOVEMENT_KINDS } from './types.js'
import type { Money } from '../money/index.js'

export class ValidationError extends Error {
  public readonly code = 'INVALID'
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`)
    this.name = 'ValidationError'
  }
}

/** Classic account: `G` + 55 base32 characters. Checksums are the SDK's job. */
const ACCOUNT_RE = /^G[A-Z2-7]{55}$/
/** Muxed account: `M` + 68 base32 characters. */
const MUXED_RE = /^M[A-Z2-7]{68}$/
/** Contract: `C` + 55 base32 characters. */
const CONTRACT_RE = /^C[A-Z2-7]{55}$/
const HEX32_RE = /^[0-9a-f]{64}$/
const UINT64_MAX = (1n << 64n) - 1n
const MAX_TEXT = 256

export function isAccountId(value: string): boolean {
  return ACCOUNT_RE.test(value)
}

/**
 * PostgreSQL text cannot hold NUL, and a lone surrogate is not text at all: a
 * SQL store would silently save something else. So no store accepts either: a
 * value is valid in every store or in none, and bad input is refused here
 * rather than surfacing as a database error. Memos are the exception: they are
 * facts from the chain, and every store keeps them as bytes.
 */
export function assertStorableText(field: string, value: string): void {
  if (value.includes('\0')) throw new ValidationError(field, 'must not contain a NUL character')
  if (/\p{Cs}/u.test(value)) throw new ValidationError(field, 'must be well-formed Unicode')
}

function text(field: string, value: unknown, max = MAX_TEXT): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(field, 'must be a non-empty string')
  }
  if (value.length > max) {
    throw new ValidationError(field, `must be at most ${max} characters`)
  }
  assertStorableText(field, value)
}

function account(field: string, value: unknown): void {
  if (typeof value !== 'string' || !ACCOUNT_RE.test(value)) {
    throw new ValidationError(field, 'must be a G... account id')
  }
}

function positive(field: string, value: Money): void {
  if (!value.isPositive()) {
    throw new ValidationError(field, `must be positive, got ${value.toString()}`)
  }
}

function uint64(field: string, value: unknown): void {
  if (typeof value !== 'bigint' || value < 0n || value > UINT64_MAX) {
    throw new ValidationError(field, 'must be a bigint in the uint64 range')
  }
}

function date(field: string, value: unknown): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ValidationError(field, 'must be a valid Date')
  }
}

function direction(field: string, value: unknown): void {
  if (value !== 'credit' && value !== 'debit') {
    throw new ValidationError(field, 'must be "credit" or "debit"')
  }
}

export function assertValidMemo(field: string, memo: Memo): void {
  switch (memo.type) {
    case 'text':
      if (typeof memo.value !== 'string') throw new ValidationError(field, 'text memo must be a string')
      return
    case 'id':
      uint64(`${field}.value`, memo.value)
      return
    case 'hash':
    case 'return':
      if (typeof memo.value !== 'string' || !HEX32_RE.test(memo.value)) {
        throw new ValidationError(field, `${memo.type} memo must be 64 lowercase hex characters`)
      }
      return
    default:
      throw new ValidationError(field, `unknown memo type ${JSON.stringify((memo as Memo).type)}`)
  }
}

export function assertValidNewMovement(m: NewMovement): void {
  text('tenantId', m.tenantId)
  text('network', m.network)
  text('source', m.source)
  text('externalId', m.externalId)
  if (m.revision !== undefined && (!Number.isSafeInteger(m.revision) || m.revision < 1)) {
    throw new ValidationError('revision', 'must be a positive integer')
  }
  account('account', m.account)
  direction('direction', m.direction)
  if (!MOVEMENT_KINDS.includes(m.kind)) {
    throw new ValidationError('kind', `must be one of ${MOVEMENT_KINDS.join(', ')}`)
  }
  positive('amount', m.amount)
  if (m.counterparty != null) {
    const c = m.counterparty
    if (!(ACCOUNT_RE.test(c) || MUXED_RE.test(c) || CONTRACT_RE.test(c))) {
      throw new ValidationError('counterparty', 'must be a G..., M... or C... address')
    }
  }
  if (m.muxedId != null) uint64('muxedId', m.muxedId)
  if (m.memo != null) assertValidMemo('memo', m.memo)
  if (!Number.isSafeInteger(m.ledger) || m.ledger < 1) {
    throw new ValidationError('ledger', 'must be a positive integer')
  }
  if (m.txHash != null && (typeof m.txHash !== 'string' || !HEX32_RE.test(m.txHash))) {
    throw new ValidationError('txHash', 'must be 64 lowercase hex characters')
  }
  if (m.operationId != null) text('operationId', m.operationId)
  date('occurredAt', m.occurredAt)
  if (m.enrichment !== undefined && m.enrichment !== 'complete' && m.enrichment !== 'missing') {
    throw new ValidationError('enrichment', 'must be "complete" or "missing"')
  }
}

export function assertValidNewExpectation(e: NewExpectation): void {
  text('tenantId', e.tenantId)
  text('reference', e.reference)
  account('account', e.account)
  if (e.direction !== undefined) direction('direction', e.direction)
  positive('amount', e.amount)
  if (e.muxedId != null) uint64('muxedId', e.muxedId)
  if (e.memo != null) assertValidMemo('memo', e.memo)
  e.payers?.forEach((p, i) => account(`payers[${i}]`, p))
  if (e.dueAt != null) date('dueAt', e.dueAt)
  if (e.expiresAt != null) date('expiresAt', e.expiresAt)
  if (e.metadata !== undefined) {
    for (const [k, v] of Object.entries(e.metadata)) {
      if (typeof v !== 'string') throw new ValidationError(`metadata.${k}`, 'must be a string')
      assertStorableText('metadata', k)
      assertStorableText(`metadata.${k}`, v)
    }
  }
}

export function assertValidNewAllocation(a: NewAllocation): void {
  text('tenantId', a.tenantId)
  text('movementId', a.movementId)
  text('expectationId', a.expectationId)
  positive('amount', a.amount)
  text('strategy', a.strategy)
  if (a.score != null && !(Number.isFinite(a.score) && a.score >= 0 && a.score <= 1)) {
    throw new ValidationError('score', 'must be a number in [0, 1]')
  }
}

export function assertValidNewException(e: NewException): void {
  text('tenantId', e.tenantId)
  if (!EXCEPTION_CODES.includes(e.code)) {
    throw new ValidationError('code', `unknown exception code ${JSON.stringify(e.code)}`)
  }
  if (e.movementId == null && e.expectationId == null && e.account == null) {
    throw new ValidationError('subject', 'an exception needs a movementId, expectationId or account')
  }
  if (e.account != null) account('account', e.account)
  text('detail', e.detail, 2_000)
}

export function assertValidNewJournalEntry(e: NewJournalEntry): void {
  text('tenantId', e.tenantId)
  if (!JOURNAL_ENTRY_KINDS.includes(e.kind)) {
    throw new ValidationError('kind', `must be one of ${JOURNAL_ENTRY_KINDS.join(', ')}`)
  }
  text('description', e.description, 500)
  if (e.effectiveAt !== undefined) date('effectiveAt', e.effectiveAt)
  if (e.movementId != null) text('movementId', e.movementId)
  if ((e.movementId == null) !== (e.postingNo == null)) {
    throw new ValidationError('postingNo', 'is required with a movementId, and only then')
  }
  if (e.postingNo != null && (!Number.isSafeInteger(e.postingNo) || e.postingNo < 1)) {
    throw new ValidationError('postingNo', 'must be a positive integer')
  }
  if (!Array.isArray(e.lines) || e.lines.length < 2) {
    throw new ValidationError('lines', 'an entry needs at least two lines')
  }
  const decimals = new Map<string, number>()
  e.lines.forEach((line, i) => {
    text(`lines[${i}].account`, line.account)
    if (!LINE_ROLES.includes(line.role)) {
      throw new ValidationError(`lines[${i}].role`, `must be one of ${LINE_ROLES.join(', ')}`)
    }
    if (line.side !== 'debit' && line.side !== 'credit') {
      throw new ValidationError(`lines[${i}].side`, 'must be "debit" or "credit"')
    }
    positive(`lines[${i}].amount`, line.amount)
    const seen = decimals.get(line.amount.asset)
    if (seen !== undefined && seen !== line.amount.decimals) {
      throw new ValidationError(`lines[${i}].amount`, `${line.amount.asset} appears with ${seen} and ${line.amount.decimals} decimals`)
    }
    decimals.set(line.amount.asset, line.amount.decimals)
    if (line.expectationId != null) text(`lines[${i}].expectationId`, line.expectationId)
    if (line.exceptionId != null) text(`lines[${i}].exceptionId`, line.exceptionId)
  })
}
