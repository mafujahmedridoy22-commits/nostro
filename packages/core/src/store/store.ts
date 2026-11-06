/**
 * The storage contract every backend implements.
 *
 * Writes exist only on `StoreTx`, which is only reachable inside
 * `store.transaction()`. That is deliberate: ADR 0005 requires the ingest
 * cursor to advance in the same transaction as the movements it covers, and
 * the cleanest way to make that impossible to get wrong is to offer no way to
 * write outside a transaction at all.
 *
 * The constraints below are part of the contract, not suggestions. Every store
 * must enforce them itself — Postgres with constraints and row locks, the
 * memory store in code — and the shared conformance suite checks that they do.
 */
import type {
  Allocation,
  CursorKey,
  Direction,
  Disposition,
  ExceptionCode,
  ExceptionRecord,
  ExceptionStatus,
  Expectation,
  ExpectationStatus,
  JournalEntry,
  Movement,
  NewAllocation,
  NewException,
  NewExpectation,
  NewJournalEntry,
  NewMovement,
} from '../model/index.js'
import type { AssetId } from '../money/index.js'
import type { EventQuery, OutboxEvent } from './events.js'

export interface MovementQuery {
  readonly tenantId: string
  readonly disposition?: Disposition
  readonly account?: string
  /** Return movements with `seq` greater than this; for paging in ingest order. */
  readonly afterSeq?: number
  readonly limit?: number
}

export interface ExpectationQuery {
  readonly tenantId: string
  readonly account?: string
  readonly asset?: AssetId
  readonly direction?: Direction
  readonly status?: readonly ExpectationStatus[]
  readonly muxedId?: bigint
  /** Return expectations with `seq` greater than this; for paging in creation order. */
  readonly afterSeq?: number
  readonly limit?: number
}

export interface AllocationQuery {
  readonly tenantId: string
  readonly movementId?: string
  readonly expectationId?: string
}

export interface ExceptionQuery {
  readonly tenantId: string
  readonly status?: ExceptionStatus
  readonly code?: ExceptionCode
  readonly movementId?: string
  readonly expectationId?: string
  /** Return exceptions with `seq` greater than this; for paging in opening order. */
  readonly afterSeq?: number
  readonly limit?: number
}

/** A re-delivered movement whose facts differ from what was first recorded. */
export interface MovementConflict {
  readonly existing: Movement
  readonly incoming: NewMovement
}

export interface InsertMovementsResult {
  /** Newly recorded movements, in ingest order. */
  readonly inserted: readonly Movement[]
  /** Re-deliveries identical to what is already recorded. Safe to ignore. */
  readonly duplicates: readonly Movement[]
  /**
   * Re-deliveries that disagree with the recorded facts. The recorded row is
   * left untouched; the caller decides whether this is a source correction
   * (bump `revision` via reingest) or a `SOURCE_GAP_DETECTED` exception.
   */
  readonly conflicts: readonly MovementConflict[]
}

export interface Resolution {
  readonly status: Exclude<ExceptionStatus, 'open'>
  readonly note: string
}

/** Read access. Every lookup is scoped by tenant; ids from another tenant read as absent. */
export interface StoreReader extends JournalReader {
  getMovement(tenantId: string, id: string): Promise<Movement | null>
  listMovements(query: MovementQuery): Promise<Movement[]>
  getExpectation(tenantId: string, id: string): Promise<Expectation | null>
  getExpectationByReference(tenantId: string, reference: string): Promise<Expectation | null>
  listExpectations(query: ExpectationQuery): Promise<Expectation[]>
  listAllocations(query: AllocationQuery): Promise<Allocation[]>
  getException(tenantId: string, id: string): Promise<ExceptionRecord | null>
  listExceptions(query: ExceptionQuery): Promise<ExceptionRecord[]>
  getCursor(key: CursorKey): Promise<string | null>
  /** The event log, in `seq` order. Events are written by the store itself; see `events.ts`. */
  listEvents(query: EventQuery): Promise<OutboxEvent[]>
}

/**
 * Read and write access within a single transaction.
 *
 * `getCursor` and `getMovement` here are locking reads: once a transaction
 * has read a cursor or a movement, no other transaction can read or write it
 * until the first ends. That is what makes the compare-and-set in `sync()`
 * hold when two workers race, and what lets two reconcilers skip a movement
 * the other has just handled instead of colliding on it. A SQL store must
 * lock the row (creating a cursor row if absent) rather than rely on its
 * default isolation level.
 */
export interface StoreTx extends StoreReader, JournalTx {
  /**
   * Record movements, deduplicated on `(tenantId, network, source, externalId)`.
   * Never overwrites: a re-delivery is reported as a duplicate or a conflict.
   */
  insertMovements(batch: readonly NewMovement[]): Promise<InsertMovementsResult>

  /**
   * Move a movement to a new disposition, writing a `movement.decided` event
   * if it changed. The store refuses a disposition the
   * movement's allocations and exceptions do not support:
   * - `allocated` needs allocations summing to the full amount
   * - `partial` needs some allocation and an open exception on the movement
   * - `exception` needs at least one exception on the movement
   * - `ignored` needs a reason
   */
  setDisposition(
    tenantId: string,
    movementId: string,
    disposition: Disposition,
    reason?: string,
  ): Promise<Movement>

  setCursor(key: CursorKey, value: string): Promise<void>

  /** Fails with `expectation_reference_unique` if the reference is taken in this tenant. */
  insertExpectation(expectation: NewExpectation): Promise<Expectation>

  /**
   * Fails with `expectation_has_allocations` once anything has been allocated
   * to it. Writes an `expectation.cancelled` event.
   */
  cancelExpectation(tenantId: string, id: string, reason: string): Promise<Expectation>

  /**
   * Allocate part of a movement to an expectation, and update the
   * expectation's status. Refuses (see `ConstraintName`) a cross-asset,
   * cross-direction or cross-account allocation, a second allocation for the same pair, a
   * cancelled expectation, or anything that would over-allocate either side.
   * The over-allocation checks see every committed allocation, so two
   * concurrent transactions cannot both spend the same remaining amount.
   * Writes an `expectation.partially_paid` or `expectation.settled` event
   * when the status changes.
   */
  allocate(allocation: NewAllocation): Promise<Allocation>

  /** Writes an `exception.opened` event. */
  openException(exception: NewException): Promise<ExceptionRecord>
  /** Writes an `exception.resolved` or `exception.dismissed` event. */
  resolveException(tenantId: string, id: string, resolution: Resolution): Promise<ExceptionRecord>
}

export interface JournalQuery {
  readonly tenantId: string
  readonly movementId?: string
  /** Entries with `seq` greater than this, for paging in posting order. */
  readonly afterSeq?: number
  /** Effective on or after this instant. */
  readonly effectiveFrom?: Date
  /** Effective strictly before this instant. */
  readonly effectiveBefore?: Date
  readonly limit?: number
}

/** Read access to the journal. Entries come back in posting (`seq`) order. */
export interface JournalReader {
  listJournalEntries(query: JournalQuery): Promise<JournalEntry[]>
}

/** Posting to the journal, inside a transaction. */
export interface JournalTx extends JournalReader {
  /**
   * Append a balanced entry. Entries are never edited or deleted. For an
   * entry tied to a movement, the store locks the movement, then applies
   * `checkJournalEntry` against the movement's earlier entries, so two
   * concurrent posters cannot both append the same posting number.
   * Expectations and exceptions named on lines must exist in the tenant.
   */
  postJournalEntry(entry: NewJournalEntry): Promise<JournalEntry>
}

export interface Store extends StoreReader {
  /**
   * Run `fn` in a transaction. Commits if it resolves, rolls back everything
   * it wrote if it throws, and rethrows. The `tx` handle is dead once `fn`
   * settles. Do not nest transactions.
   */
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>
  close(): Promise<void>
}

/** Where a database's schema is, against where this store would take it. */
export interface SchemaVersion {
  /** The version the database is at; 0 for one never migrated. */
  readonly current: number
  /** The version `migrate()` brings it to. */
  readonly latest: number
}

/**
 * A store backed by a database with a schema of its own. Opening one never
 * changes the schema; only `migrate()` does, so upgrading nostro cannot alter
 * a production database behind anyone's back.
 */
export interface MigratableStore extends Store {
  /** Apply any pending migrations. */
  migrate(): Promise<void>
  schemaVersion(): Promise<SchemaVersion>
}

export type ConstraintName =
  | 'allocation_unique'
  | 'allocation_asset'
  | 'allocation_direction'
  | 'allocation_account'
  | 'allocation_over_movement'
  | 'allocation_over_expectation'
  | 'allocation_expectation_cancelled'
  | 'expectation_reference_unique'
  | 'expectation_has_allocations'
  | 'expectation_not_open'
  | 'disposition_unsupported'
  | 'movement_not_open'
  | 'exception_not_open'
  | 'journal_unbalanced'
  | 'journal_posting_conflict'
  | 'journal_cash_mismatch'
  | 'journal_asset'

export class StoreError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'CONSTRAINT' | 'TX_CLOSED',
    message: string,
  ) {
    super(message)
    this.name = 'StoreError'
  }
}

export class NotFoundError extends StoreError {
  constructor(
    public readonly entity: 'movement' | 'expectation' | 'exception',
    public readonly id: string,
  ) {
    super('NOT_FOUND', `${entity} ${id} not found`)
    this.name = 'NotFoundError'
  }
}

export class ConstraintError extends StoreError {
  constructor(
    public readonly constraint: ConstraintName,
    message: string,
  ) {
    super('CONSTRAINT', `${constraint}: ${message}`)
    this.name = 'ConstraintError'
  }
}

export class TransactionClosedError extends StoreError {
  constructor() {
    super('TX_CLOSED', 'This transaction has already committed or rolled back.')
    this.name = 'TransactionClosedError'
  }
}
