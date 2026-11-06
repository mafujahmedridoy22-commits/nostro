/**
 * An in-process `Store` with no dependencies.
 *
 * It exists so the quickstart runs with no database and so the matching engine
 * can be tested with no I/O. It is not a toy, though: it enforces every
 * constraint in the `Store` contract and passes the same conformance suite as
 * the SQL stores.
 *
 * Transactions are serialised: each one runs against a private copy of the
 * committed state, which replaces the committed state only if the callback
 * resolves. That gives serializable isolation and all-or-nothing rollback.
 * Reads outside a transaction see committed state only.
 *
 * Each transaction copies the state's indexes, so cost grows with the number
 * of records. That is fine for tests, development and small deployments; use
 * a SQL store for anything long-lived.
 */
import type {
  Allocation,
  CursorKey,
  Disposition,
  ExceptionRecord,
  Expectation,
  JournalEntry,
  Movement,
  NewAllocation,
  NewException,
  NewExpectation,
  NewJournalEntry,
  NewMovement,
} from '../model/index.js'
import {
  assertValidNewJournalEntry,
  assertValidNewAllocation,
  assertValidNewException,
  assertValidNewExpectation,
  assertValidNewMovement,
} from '../model/index.js'
import type {
  AllocationQuery,
  ExceptionQuery,
  ExpectationQuery,
  InsertMovementsResult,
  JournalQuery,
  MovementConflict,
  MovementQuery,
  Resolution,
  Store,
  StoreReader,
  StoreTx,
} from './store.js'
import {
  checkAllocation,
  checkCancel,
  checkCursorValue,
  checkDisposition,
  checkJournalEntry,
  checkResolution,
  storedMemo,
  sameFacts,
} from './rules.js'
import { ConstraintError, NotFoundError, TransactionClosedError } from './store.js'
import type { EventQuery, NewOutboxEvent, OutboxEvent } from './events.js'
import { exceptionChanged, expectationChanged, movementDecided } from './events.js'

export interface MemoryStoreOptions {
  /** Id generator. Defaults to `crypto.randomUUID()`; inject one for deterministic tests. */
  readonly ids?: () => string
  /** Clock for `createdAt` and friends. Defaults to `new Date()`. */
  readonly now?: () => Date
}

interface State {
  seq: number
  readonly movements: Map<string, Movement>
  /** Dedupe key → movement id. */
  readonly movementKeys: Map<string, string>
  readonly expectations: Map<string, Expectation>
  /** (tenant, reference) → expectation id. */
  readonly expectationRefs: Map<string, string>
  readonly allocations: Map<string, Allocation>
  readonly exceptions: Map<string, ExceptionRecord>
  readonly cursors: Map<string, string>
  journalSeq: number
  readonly journal: Map<string, JournalEntry>
  eventSeq: number
  readonly events: Map<string, OutboxEvent>
  /** Movement id → its entry ids in posting order. Arrays are replaced, never pushed to. */
  readonly journalByMovement: Map<string, readonly string[]>
}

function emptyState(): State {
  return {
    seq: 0,
    movements: new Map(),
    movementKeys: new Map(),
    expectations: new Map(),
    expectationRefs: new Map(),
    allocations: new Map(),
    exceptions: new Map(),
    cursors: new Map(),
    journalSeq: 0,
    journal: new Map(),
    journalByMovement: new Map(),
    eventSeq: 0,
    events: new Map(),
  }
}

/** Records are frozen, so copying the indexes is a complete snapshot. */
function cloneState(s: State): State {
  return {
    seq: s.seq,
    movements: new Map(s.movements),
    movementKeys: new Map(s.movementKeys),
    expectations: new Map(s.expectations),
    expectationRefs: new Map(s.expectationRefs),
    allocations: new Map(s.allocations),
    exceptions: new Map(s.exceptions),
    cursors: new Map(s.cursors),
    journalSeq: s.journalSeq,
    journal: new Map(s.journal),
    journalByMovement: new Map(s.journalByMovement),
    eventSeq: s.eventSeq,
    events: new Map(s.events),
  }
}

const key = (...parts: readonly string[]): string => JSON.stringify(parts)
const movementKey = (m: { tenantId: string; network: string; source: string; externalId: string }) =>
  key(m.tenantId, m.network, m.source, m.externalId)
const cursorKey = (k: CursorKey) => key(k.tenantId, k.network, k.source, k.account)
const copyDate = (d: Date): Date => new Date(d.getTime())

abstract class MemoryReader implements StoreReader {
  /** The state reads run against: committed state, or a transaction's draft. */
  protected abstract snapshot(): State

  protected check(): void {}

  async getMovement(tenantId: string, id: string): Promise<Movement | null> {
    this.check()
    const m = this.snapshot().movements.get(id)
    return m !== undefined && m.tenantId === tenantId ? m : null
  }

  async listMovements(q: MovementQuery): Promise<Movement[]> {
    this.check()
    const out: Movement[] = []
    for (const m of this.snapshot().movements.values()) {
      if (m.tenantId !== q.tenantId) continue
      if (q.disposition !== undefined && m.disposition !== q.disposition) continue
      if (q.account !== undefined && m.account !== q.account) continue
      if (q.afterSeq !== undefined && m.seq <= q.afterSeq) continue
      out.push(m)
    }
    out.sort((a, b) => a.seq - b.seq)
    return q.limit === undefined ? out : out.slice(0, q.limit)
  }

  async getExpectation(tenantId: string, id: string): Promise<Expectation | null> {
    this.check()
    const e = this.snapshot().expectations.get(id)
    return e !== undefined && e.tenantId === tenantId ? e : null
  }

  async getExpectationByReference(tenantId: string, reference: string): Promise<Expectation | null> {
    this.check()
    const id = this.snapshot().expectationRefs.get(key(tenantId, reference))
    return id === undefined ? null : (this.snapshot().expectations.get(id) ?? null)
  }

  async listExpectations(q: ExpectationQuery): Promise<Expectation[]> {
    this.check()
    const out: Expectation[] = []
    for (const e of this.snapshot().expectations.values()) {
      if (e.tenantId !== q.tenantId) continue
      if (q.account !== undefined && e.account !== q.account) continue
      if (q.asset !== undefined && e.amount.asset !== q.asset) continue
      if (q.direction !== undefined && e.direction !== q.direction) continue
      if (q.status !== undefined && !q.status.includes(e.status)) continue
      if (q.muxedId !== undefined && e.muxedId !== q.muxedId) continue
      if (q.afterSeq !== undefined && e.seq <= q.afterSeq) continue
      out.push(e)
      if (q.limit !== undefined && out.length >= q.limit) break
    }
    return out
  }

  async listAllocations(q: AllocationQuery): Promise<Allocation[]> {
    this.check()
    const out: Allocation[] = []
    for (const a of this.snapshot().allocations.values()) {
      if (a.tenantId !== q.tenantId) continue
      if (q.movementId !== undefined && a.movementId !== q.movementId) continue
      if (q.expectationId !== undefined && a.expectationId !== q.expectationId) continue
      out.push(a)
    }
    return out
  }

  async getException(tenantId: string, id: string): Promise<ExceptionRecord | null> {
    this.check()
    const e = this.snapshot().exceptions.get(id)
    return e !== undefined && e.tenantId === tenantId ? e : null
  }

  async listExceptions(q: ExceptionQuery): Promise<ExceptionRecord[]> {
    this.check()
    const out: ExceptionRecord[] = []
    for (const e of this.snapshot().exceptions.values()) {
      if (e.tenantId !== q.tenantId) continue
      if (q.status !== undefined && e.status !== q.status) continue
      if (q.code !== undefined && e.code !== q.code) continue
      if (q.movementId !== undefined && e.movementId !== q.movementId) continue
      if (q.expectationId !== undefined && e.expectationId !== q.expectationId) continue
      if (q.afterSeq !== undefined && e.seq <= q.afterSeq) continue
      out.push(e)
      if (q.limit !== undefined && out.length >= q.limit) break
    }
    return out
  }

  async listEvents(q: EventQuery): Promise<OutboxEvent[]> {
    this.check()
    const out: OutboxEvent[] = []
    for (const e of this.snapshot().events.values()) {
      if (e.tenantId !== q.tenantId) continue
      if (q.afterSeq !== undefined && e.seq <= q.afterSeq) continue
      out.push(e)
      if (q.limit !== undefined && out.length >= q.limit) break
    }
    return out
  }

  async listJournalEntries(q: JournalQuery): Promise<JournalEntry[]> {
    this.check()
    const state = this.snapshot()
    const ids =
      q.movementId === undefined ? [...state.journal.keys()] : (state.journalByMovement.get(q.movementId) ?? [])
    const out: JournalEntry[] = []
    for (const id of ids) {
      const e = state.journal.get(id)!
      if (e.tenantId !== q.tenantId) continue
      if (q.afterSeq !== undefined && e.seq <= q.afterSeq) continue
      if (q.effectiveFrom !== undefined && e.effectiveAt.getTime() < q.effectiveFrom.getTime()) continue
      if (q.effectiveBefore !== undefined && e.effectiveAt.getTime() >= q.effectiveBefore.getTime()) continue
      out.push(e)
    }
    out.sort((a, b) => a.seq - b.seq)
    return q.limit === undefined ? out : out.slice(0, q.limit)
  }

  async getCursor(k: CursorKey): Promise<string | null> {
    this.check()
    return this.snapshot().cursors.get(cursorKey(k)) ?? null
  }
}

class MemoryTx extends MemoryReader implements StoreTx {
  private open = true

  constructor(
    readonly draft: State,
    private readonly ids: () => string,
    private readonly now: () => Date,
  ) {
    super()
  }

  protected snapshot(): State {
    return this.draft
  }

  close(): void {
    this.open = false
  }

  protected override check(): void {
    if (!this.open) throw new TransactionClosedError()
  }

  private movement(tenantId: string, id: string): Movement {
    const m = this.draft.movements.get(id)
    if (m === undefined || m.tenantId !== tenantId) throw new NotFoundError('movement', id)
    return m
  }

  private expectation(tenantId: string, id: string): Expectation {
    const e = this.draft.expectations.get(id)
    if (e === undefined || e.tenantId !== tenantId) throw new NotFoundError('expectation', id)
    return e
  }

  private allocationsOf(field: 'movementId' | 'expectationId', id: string): Allocation[] {
    return [...this.draft.allocations.values()].filter((a) => a[field] === id)
  }

  /** Append to the event log, in this transaction. */
  private emit(event: NewOutboxEvent | null): void {
    if (event === null) return
    const record: OutboxEvent = Object.freeze({
      id: this.ids(),
      seq: ++this.draft.eventSeq,
      ...event,
      createdAt: this.now(),
    })
    this.draft.events.set(record.id, record)
  }

  async insertMovements(batch: readonly NewMovement[]): Promise<InsertMovementsResult> {
    this.check()
    batch.forEach(assertValidNewMovement)
    const inserted: Movement[] = []
    const duplicates: Movement[] = []
    const conflicts: MovementConflict[] = []
    for (const n of batch) {
      const candidate: Movement = Object.freeze({
        id: '',
        tenantId: n.tenantId,
        seq: 0,
        network: n.network,
        source: n.source,
        externalId: n.externalId,
        revision: n.revision ?? 1,
        account: n.account,
        direction: n.direction,
        kind: n.kind,
        amount: n.amount,
        counterparty: n.counterparty ?? null,
        muxedId: n.muxedId ?? null,
        memo: n.memo == null ? null : Object.freeze(storedMemo(n.memo)),
        ledger: n.ledger,
        txHash: n.txHash ?? null,
        operationId: n.operationId ?? null,
        occurredAt: copyDate(n.occurredAt),
        enrichment: n.enrichment ?? 'complete',
        disposition: 'pending',
        ignoredReason: null,
        createdAt: this.now(),
      })
      const k = movementKey(n)
      const existingId = this.draft.movementKeys.get(k)
      if (existingId !== undefined) {
        const existing = this.draft.movements.get(existingId)!
        if (sameFacts(existing, n)) duplicates.push(existing)
        else conflicts.push({ existing, incoming: n })
        continue
      }
      const movement: Movement = Object.freeze({
        ...candidate,
        id: this.ids(),
        seq: ++this.draft.seq,
      })
      this.draft.movements.set(movement.id, movement)
      this.draft.movementKeys.set(k, movement.id)
      inserted.push(movement)
    }
    return { inserted, duplicates, conflicts }
  }

  async setDisposition(
    tenantId: string,
    movementId: string,
    disposition: Disposition,
    reason?: string,
  ): Promise<Movement> {
    this.check()
    const m = this.movement(tenantId, movementId)
    checkDisposition(
      m,
      this.allocationsOf('movementId', m.id),
      [...this.draft.exceptions.values()].filter((e) => e.movementId === m.id),
      disposition,
      reason,
    )
    const next: Movement = Object.freeze({
      ...m,
      disposition,
      ignoredReason: disposition === 'ignored' ? reason! : null,
    })
    this.draft.movements.set(next.id, next)
    if (m.disposition !== disposition) this.emit(movementDecided(next, m.disposition, this.allocationsOf('movementId', m.id)))
    return next
  }

  async setCursor(k: CursorKey, value: string): Promise<void> {
    this.check()
    checkCursorValue(value)
    this.draft.cursors.set(cursorKey(k), value)
  }

  async insertExpectation(n: NewExpectation): Promise<Expectation> {
    this.check()
    assertValidNewExpectation(n)
    const refKey = key(n.tenantId, n.reference)
    if (this.draft.expectationRefs.has(refKey)) {
      throw new ConstraintError(
        'expectation_reference_unique',
        `reference ${JSON.stringify(n.reference)} already exists in this tenant`,
      )
    }
    const now = this.now()
    const expectation: Expectation = Object.freeze({
      id: this.ids(),
      tenantId: n.tenantId,
      seq: ++this.draft.seq,
      reference: n.reference,
      account: n.account,
      direction: n.direction ?? 'credit',
      amount: n.amount,
      muxedId: n.muxedId ?? null,
      memo: n.memo == null ? null : Object.freeze(storedMemo(n.memo)),
      payers: Object.freeze([...(n.payers ?? [])]),
      dueAt: n.dueAt == null ? null : copyDate(n.dueAt),
      expiresAt: n.expiresAt == null ? null : copyDate(n.expiresAt),
      status: 'open',
      cancelReason: null,
      metadata: Object.freeze({ ...(n.metadata ?? {}) }),
      createdAt: now,
      updatedAt: now,
    })
    this.draft.expectations.set(expectation.id, expectation)
    this.draft.expectationRefs.set(refKey, expectation.id)
    return expectation
  }

  async cancelExpectation(tenantId: string, id: string, reason: string): Promise<Expectation> {
    this.check()
    const e = this.expectation(tenantId, id)
    checkCancel(e, reason)
    const next: Expectation = Object.freeze({
      ...e,
      status: 'cancelled',
      cancelReason: reason,
      updatedAt: this.now(),
    })
    this.draft.expectations.set(id, next)
    this.emit(expectationChanged(next, null))
    return next
  }

  async allocate(n: NewAllocation): Promise<Allocation> {
    this.check()
    assertValidNewAllocation(n)
    const m = this.movement(n.tenantId, n.movementId)
    const e = this.expectation(n.tenantId, n.expectationId)

    const status = checkAllocation(
      n,
      m,
      e,
      this.allocationsOf('movementId', m.id),
      this.allocationsOf('expectationId', e.id),
    )

    const now = this.now()
    const allocation: Allocation = Object.freeze({
      id: this.ids(),
      tenantId: n.tenantId,
      movementId: m.id,
      expectationId: e.id,
      amount: n.amount,
      strategy: n.strategy,
      score: n.score ?? null,
      createdAt: now,
    })
    this.draft.allocations.set(allocation.id, allocation)
    const updated: Expectation = Object.freeze({ ...e, status, updatedAt: now })
    this.draft.expectations.set(e.id, updated)
    if (status !== e.status) this.emit(expectationChanged(updated, allocation))
    return allocation
  }

  async postJournalEntry(n: NewJournalEntry): Promise<JournalEntry> {
    this.check()
    assertValidNewJournalEntry(n)
    const movement = n.movementId == null ? null : this.movement(n.tenantId, n.movementId)
    const existing = movement === null ? [] : await this.listJournalEntries({ tenantId: n.tenantId, movementId: movement.id })
    checkJournalEntry(n, movement, existing)
    for (const line of n.lines) {
      if (line.expectationId != null) this.expectation(n.tenantId, line.expectationId)
      if (line.exceptionId != null) {
        const x = this.draft.exceptions.get(line.exceptionId)
        if (x === undefined || x.tenantId !== n.tenantId) throw new NotFoundError('exception', line.exceptionId)
      }
    }
    const now = this.now()
    const entry: JournalEntry = Object.freeze({
      id: this.ids(),
      tenantId: n.tenantId,
      seq: ++this.draft.journalSeq,
      movementId: movement?.id ?? null,
      postingNo: n.postingNo ?? null,
      kind: n.kind,
      effectiveAt: copyDate(n.effectiveAt ?? now),
      postedAt: now,
      description: n.description,
      lines: Object.freeze(
        n.lines.map((l) =>
          Object.freeze({
            account: l.account,
            role: l.role,
            side: l.side,
            amount: l.amount,
            expectationId: l.expectationId ?? null,
            exceptionId: l.exceptionId ?? null,
          }),
        ),
      ),
    })
    this.draft.journal.set(entry.id, entry)
    if (movement !== null) {
      this.draft.journalByMovement.set(movement.id, [...(this.draft.journalByMovement.get(movement.id) ?? []), entry.id])
    }
    return entry
  }

  async openException(n: NewException): Promise<ExceptionRecord> {
    this.check()
    assertValidNewException(n)
    if (n.movementId != null) this.movement(n.tenantId, n.movementId)
    if (n.expectationId != null) this.expectation(n.tenantId, n.expectationId)
    const record: ExceptionRecord = Object.freeze({
      id: this.ids(),
      tenantId: n.tenantId,
      seq: ++this.draft.seq,
      code: n.code,
      status: 'open',
      movementId: n.movementId ?? null,
      expectationId: n.expectationId ?? null,
      account: n.account ?? null,
      amount: n.amount ?? null,
      detail: n.detail,
      evidence: n.evidence ?? null,
      openedAt: this.now(),
      resolvedAt: null,
      resolutionNote: null,
    })
    this.draft.exceptions.set(record.id, record)
    this.emit(exceptionChanged(record))
    return record
  }

  async resolveException(tenantId: string, id: string, resolution: Resolution): Promise<ExceptionRecord> {
    this.check()
    const e = this.draft.exceptions.get(id)
    if (e === undefined || e.tenantId !== tenantId) throw new NotFoundError('exception', id)
    checkResolution(e, resolution)
    const next: ExceptionRecord = Object.freeze({
      ...e,
      status: resolution.status,
      resolvedAt: this.now(),
      resolutionNote: resolution.note,
    })
    this.draft.exceptions.set(id, next)
    this.emit(exceptionChanged(next))
    return next
  }
}

export class MemoryStore extends MemoryReader implements Store {
  private committed: State = emptyState()
  private tail: Promise<unknown> = Promise.resolve()
  private readonly ids: () => string
  private readonly now: () => Date

  constructor(options: MemoryStoreOptions = {}) {
    super()
    this.ids = options.ids ?? (() => globalThis.crypto.randomUUID())
    this.now = options.now ?? (() => new Date())
  }

  protected snapshot(): State {
    return this.committed
  }

  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const tx = new MemoryTx(cloneState(this.committed), this.ids, this.now)
      try {
        const result = await fn(tx)
        this.committed = tx.draft
        return result
      } finally {
        tx.close()
      }
    })
    // The next transaction waits for this one whether it commits or not.
    this.tail = run.catch(() => undefined)
    return run
  }

  async close(): Promise<void> {}
}
