import { HorizonClient, HorizonEffectsSource, HorizonFeesSource } from '@nostro-labs/nostro'
import type { MigratableStore, MovementSource } from '@nostro-labs/nostro'
import type { Args, Network, OptionSpec } from './args.js'
import { database } from './args.js'
import type { Io } from './io.js'
import { assertCurrent, openStore } from './store.js'

export interface Command {
  readonly name: string
  /** One line, for `nostro --help`. */
  readonly summary: string
  /** What follows `nostro <name>` in the usage line. */
  readonly usage: string
  /** Paragraphs and options, for `nostro <name> --help`. */
  readonly help: string
  readonly options: OptionSpec
  /** Returns the exit status. */
  run(args: Args, io: Io): Promise<number>
}

export const COMMON_HELP = `  --db <path|url>     SQLite file, or a postgres:// URL (env NOSTRO_DB; default ./nostro.db)
  --tenant <id>       Whose records to use (env NOSTRO_TENANT; default "default")
  --json              Print JSON instead of text
  -h, --help          Show this help`

export const NETWORK_HELP = `  --account <G...>    An account to work on; repeat for more (env NOSTRO_ACCOUNTS)
  --network <name>    testnet, public, or another label with --horizon (env NOSTRO_NETWORK; default testnet)
  --horizon <url>     The Horizon to read (env NOSTRO_HORIZON_URL; default: the network's public one)`

/** Open the database, check its schema, run `fn`, and close it whatever happens. */
export async function withStore<T>(args: Args, io: Io, fn: (store: MigratableStore) => Promise<T>): Promise<T> {
  const opened = await openStore(database(args, io), io, { create: false })
  try {
    await assertCurrent(opened)
    return await fn(opened.store)
  } finally {
    await opened.store.close()
  }
}

export function horizonClient(network: Network, io: Io): HorizonClient {
  return new HorizonClient({ url: network.horizon, ...(io.fetch === undefined ? {} : { fetch: io.fetch }) })
}

/**
 * Both Horizon sources. Fees are not effects, so an account's movements are
 * only complete, and its balance only attests, with both.
 */
export function movementSources(client: HorizonClient, network: Network): MovementSource[] {
  return [
    new HorizonEffectsSource({ client, network: network.name }),
    new HorizonFeesSource({ client, network: network.name }),
  ]
}
