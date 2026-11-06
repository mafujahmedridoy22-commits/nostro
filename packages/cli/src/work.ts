/**
 * The two loops behind `nostro sync`, `nostro reconcile` and the worker in
 * `nostro serve`: catch every stream up, then decide everything pending.
 */
import type { AccountSyncReport, ExceptionCode, MovementSource, Store } from '@nostro-labs/nostro'
import { reconcile, sync } from '@nostro-labs/nostro'

export interface StreamProgress {
  readonly account: string
  readonly source: string
  inserted: number
  duplicates: number
  conflicts: number
  cursor: string | null
  caughtUp: boolean
  /** Another process advanced the cursor first; it is syncing this stream. */
  contended: boolean
  error: Error | null
}

function add(p: StreamProgress, r: AccountSyncReport): void {
  p.inserted += r.inserted
  p.duplicates += r.duplicates
  p.conflicts += r.conflicts
  p.cursor = r.cursor
  p.caughtUp = r.caughtUp
  p.contended = r.contended
  p.error = r.error
}

export interface SyncAllOptions {
  readonly store: Store
  readonly tenantId: string
  readonly accounts: readonly string[]
  readonly sources: readonly MovementSource[]
  /** One round of pages per stream, rather than until caught up. */
  readonly once?: boolean
  /** After each round, with the streams that round read. */
  readonly onRound?: (source: MovementSource, streams: readonly StreamProgress[]) => Promise<void>
}

/** Sync every account from every source; one entry per (source, account). */
export async function syncAll(options: SyncAllOptions): Promise<StreamProgress[]> {
  const { store, tenantId } = options
  const results: StreamProgress[] = []
  for (const source of options.sources) {
    const rows: StreamProgress[] = options.accounts.map((account) => ({
      account,
      source: source.name,
      inserted: 0,
      duplicates: 0,
      conflicts: 0,
      cursor: null,
      caughtUp: false,
      contended: false,
      error: null,
    }))
    results.push(...rows)
    let remaining = rows
    while (remaining.length > 0) {
      const report = await sync({ store, source, tenantId, accounts: remaining.map((r) => r.account) })
      report.accounts.forEach((r, i) => add(remaining[i]!, r))
      await options.onRound?.(source, remaining)
      if (options.once === true) break
      remaining = remaining.filter((r) => !r.caughtUp && !r.contended && r.error === null)
    }
  }
  return results
}

export interface ReconcileTotals {
  decided: number
  allocated: number
  partial: number
  ignored: number
  journalEntries: number
  readonly exceptions: Partial<Record<ExceptionCode, number>>
  /** Movement id → why it could not be decided. */
  readonly errors: Map<string, string>
}

/** Reconcile until nothing pending is left that can be decided. */
export async function reconcileAll(store: Store, tenantId: string, limit: number): Promise<ReconcileTotals> {
  const totals: ReconcileTotals = {
    decided: 0,
    allocated: 0,
    partial: 0,
    ignored: 0,
    journalEntries: 0,
    exceptions: {},
    errors: new Map(),
  }
  for (;;) {
    const report = await reconcile({ store, tenantId, limit })
    totals.decided += report.processed
    totals.allocated += report.allocated
    totals.partial += report.partial
    totals.ignored += report.ignored
    totals.journalEntries += report.journalEntries
    for (const [code, n] of Object.entries(report.exceptions) as [ExceptionCode, number][]) {
      totals.exceptions[code] = (totals.exceptions[code] ?? 0) + n
    }
    for (const { movementId, error } of report.errors) totals.errors.set(movementId, error.message)
    // A movement that failed stays pending, so stop once a round decides nothing new.
    if (report.processed + report.skipped === 0) return totals
  }
}
