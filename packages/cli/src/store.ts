/**
 * Open the database a command names: a `postgres://` URL, or else a SQLite
 * file (optionally written `sqlite:<path>`).
 *
 * Only `nostro migrate` creates a database or changes its schema. Every other
 * command opens an existing one and refuses to run unless its schema is
 * exactly the version this nostro expects.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { MigratableStore } from '@nostro-labs/nostro'
import { CliError } from './args.js'
import type { Io } from './io.js'

export interface OpenedStore {
  readonly store: MigratableStore
  /** How to name the database in messages; a URL's password is never shown. */
  readonly label: string
}

const POSTGRES = /^postgres(ql)?:\/\//i

/** The URL with any password replaced, so it can be printed. */
export function redact(url: string): string {
  try {
    const u = new URL(url)
    if (u.password !== '') u.password = '***'
    return u.toString()
  } catch {
    return url.replace(/\/\/[^@/]*@/, '//***@')
  }
}

export async function openStore(db: string, io: Io, options: { create: boolean }): Promise<OpenedStore> {
  if (POSTGRES.test(db)) {
    const { PostgresStore } = await import('@nostro-labs/store-postgres')
    const schema = io.env.NOSTRO_PG_SCHEMA ?? 'nostro'
    return {
      store: new PostgresStore({ connectionString: db, schema }),
      label: `${redact(db)} (schema ${schema})`,
    }
  }
  const path = db.startsWith('sqlite:') ? db.slice('sqlite:'.length) : db
  if (path === '' || path === ':memory:') throw new CliError('--db must name a database file or a postgres:// URL.')
  const filename = resolve(io.cwd, path)
  if (!options.create && !existsSync(filename)) {
    throw new CliError(`No database at ${filename}. Create it with "nostro migrate".`)
  }
  const { SqliteStore } = await import('@nostro-labs/store-sqlite')
  return { store: new SqliteStore({ filename }), label: filename }
}

/** Refuse a database whose schema is not the one this nostro was built for. */
export async function assertCurrent({ store, label }: OpenedStore): Promise<void> {
  const { current, latest } = await store.schemaVersion()
  if (current === latest) return
  if (current === 0) throw new CliError(`${label} has not been set up. Run "nostro migrate" first.`)
  if (current < latest) {
    throw new CliError(`${label} is at schema version ${current}; this nostro needs ${latest}. Run "nostro migrate".`)
  }
  throw new CliError(
    `${label} is at schema version ${current}, newer than this nostro understands (${latest}). Upgrade @nostro-labs/cli.`,
  )
}
