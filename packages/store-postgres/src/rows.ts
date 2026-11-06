/**
 * Conversions between rows and records.
 *
 * node-postgres returns `numeric` and `bigint` as strings, which is what we
 * want: they become `bigint` here and never pass through `number`.
 */
import type { Allocation, ExceptionRecord, Expectation, JournalEntry, JournalLine, Json, Memo, Movement, OutboxEvent } from '@nostro-labs/nostro'
import { Money, parseAsset } from '@nostro-labs/nostro'

export interface MovementRow {
  id: string
  seq: string
  tenant_id: string
  network: string
  source: string
  external_id: string
  revision: number
  account: string
  direction: Movement['direction']
  kind: Movement['kind']
  asset: string
  decimals: number
  amount: string
  counterparty: string | null
  muxed_id: string | null
  memo_type: Memo['type'] | null
  memo_value: string | null
  memo_text: Buffer | null
  ledger: string
  tx_hash: string | null
  operation_id: string | null
  occurred_at: Date
  enrichment: Movement['enrichment']
  disposition: Movement['disposition']
  ignored_reason: string | null
  created_at: Date
}

export interface EventRow {
  seq: string
  id: string
  tenant_id: string
  type: OutboxEvent['type']
  subject_id: string
  payload: string
  created_at: Date
}

export function toEvent(r: EventRow): OutboxEvent {
  return Object.freeze({
    id: r.id,
    tenantId: r.tenant_id,
    seq: Number(r.seq),
    type: r.type,
    subjectId: r.subject_id,
    payload: JSON.parse(r.payload) as Json,
    createdAt: r.created_at,
  })
}

export interface ExpectationRow {
  id: string
  tenant_id: string
  seq: string
  reference: string
  account: string
  direction: Expectation['direction']
  asset: string
  decimals: number
  amount: string
  muxed_id: string | null
  memo_type: Memo['type'] | null
  memo_value: string | null
  memo_text: Buffer | null
  payers: string[]
  due_at: Date | null
  expires_at: Date | null
  status: Expectation['status']
  cancel_reason: string | null
  metadata: Record<string, string>
  created_at: Date
  updated_at: Date
}

export interface AllocationRow {
  id: string
  tenant_id: string
  movement_id: string
  expectation_id: string
  asset: string
  decimals: number
  amount: string
  strategy: string
  score: number | null
  created_at: Date
}

export interface ExceptionRow {
  id: string
  tenant_id: string
  seq: string
  code: ExceptionRecord['code']
  status: ExceptionRecord['status']
  movement_id: string | null
  expectation_id: string | null
  account: string | null
  asset: string | null
  decimals: number | null
  amount: string | null
  detail: string
  evidence: Json
  opened_at: Date
  resolved_at: Date | null
  resolution_note: string | null
}

const money = (amount: string, asset: string, decimals: number): Money =>
  Money.fromRaw(BigInt(amount), parseAsset(asset), decimals)

/** Memo columns for a record: `[memo_type, memo_value, memo_text]`. */
export function memoColumns(memo: Memo | null | undefined): [string | null, string | null, Buffer | null] {
  if (memo == null) return [null, null, null]
  if (memo.type === 'text') return ['text', null, Buffer.from(memo.value, 'utf8')]
  return [memo.type, String(memo.value), null]
}

function memoOf(row: Pick<MovementRow, 'memo_type' | 'memo_value' | 'memo_text'>): Memo | null {
  switch (row.memo_type) {
    case null:
      return null
    case 'text':
      return Object.freeze({ type: 'text', value: (row.memo_text ?? Buffer.alloc(0)).toString('utf8') })
    case 'id':
      return Object.freeze({ type: 'id', value: BigInt(row.memo_value!) })
    default:
      return Object.freeze({ type: row.memo_type, value: row.memo_value! })
  }
}

export function toMovement(r: MovementRow): Movement {
  return Object.freeze({
    id: r.id,
    tenantId: r.tenant_id,
    seq: Number(r.seq),
    network: r.network,
    source: r.source,
    externalId: r.external_id,
    revision: r.revision,
    account: r.account,
    direction: r.direction,
    kind: r.kind,
    amount: money(r.amount, r.asset, r.decimals),
    counterparty: r.counterparty,
    muxedId: r.muxed_id === null ? null : BigInt(r.muxed_id),
    memo: memoOf(r),
    ledger: Number(r.ledger),
    txHash: r.tx_hash,
    operationId: r.operation_id,
    occurredAt: r.occurred_at,
    enrichment: r.enrichment,
    disposition: r.disposition,
    ignoredReason: r.ignored_reason,
    createdAt: r.created_at,
  })
}

export function toExpectation(r: ExpectationRow): Expectation {
  return Object.freeze({
    id: r.id,
    tenantId: r.tenant_id,
    seq: Number(r.seq),
    reference: r.reference,
    account: r.account,
    direction: r.direction,
    amount: money(r.amount, r.asset, r.decimals),
    muxedId: r.muxed_id === null ? null : BigInt(r.muxed_id),
    memo: memoOf(r),
    payers: Object.freeze([...r.payers]),
    dueAt: r.due_at,
    expiresAt: r.expires_at,
    status: r.status,
    cancelReason: r.cancel_reason,
    metadata: Object.freeze({ ...r.metadata }),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  })
}

export function toAllocation(r: AllocationRow): Allocation {
  return Object.freeze({
    id: r.id,
    tenantId: r.tenant_id,
    movementId: r.movement_id,
    expectationId: r.expectation_id,
    amount: money(r.amount, r.asset, r.decimals),
    strategy: r.strategy,
    score: r.score,
    createdAt: r.created_at,
  })
}

export function toException(r: ExceptionRow): ExceptionRecord {
  return Object.freeze({
    id: r.id,
    tenantId: r.tenant_id,
    seq: Number(r.seq),
    code: r.code,
    status: r.status,
    movementId: r.movement_id,
    expectationId: r.expectation_id,
    account: r.account,
    amount: r.amount === null ? null : money(r.amount, r.asset!, r.decimals!),
    detail: r.detail,
    evidence: r.evidence,
    openedAt: r.opened_at,
    resolvedAt: r.resolved_at,
    resolutionNote: r.resolution_note,
  })
}

export interface JournalEntryRow {
  id: string
  seq: string
  tenant_id: string
  movement_id: string | null
  posting_no: number | null
  kind: JournalEntry['kind']
  effective_at: Date
  posted_at: Date
  description: string
}

export interface JournalLineRow {
  entry_id: string
  line_no: number
  account: string
  role: JournalLine['role']
  side: JournalLine['side']
  asset: string
  decimals: number
  amount: string
  expectation_id: string | null
  exception_id: string | null
}

export function toJournalEntry(r: JournalEntryRow, lines: readonly JournalLineRow[]): JournalEntry {
  return Object.freeze({
    id: r.id,
    tenantId: r.tenant_id,
    seq: Number(r.seq),
    movementId: r.movement_id,
    postingNo: r.posting_no,
    kind: r.kind,
    effectiveAt: r.effective_at,
    postedAt: r.posted_at,
    description: r.description,
    lines: Object.freeze(
      lines.map((l) =>
        Object.freeze({
          account: l.account,
          role: l.role,
          side: l.side,
          amount: money(l.amount, l.asset, l.decimals),
          expectationId: l.expectation_id,
          exceptionId: l.exception_id,
        }),
      ),
    ),
  })
}
