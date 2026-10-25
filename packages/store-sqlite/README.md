# nostro-store-sqlite

SQLite store for [nostro](https://github.com/nostro-labs/nostro), for single-node deployments and
local development. Passes the same Store conformance suite as nostro's in-memory and PostgreSQL
stores.

```sh
npm install nostro nostro-store-sqlite
```

```ts
import { SqliteStore } from 'nostro-store-sqlite'

const store = new SqliteStore({ filename: './nostro.db' })
await store.migrate()
```

- Transactions take SQLite's write lock up front (`BEGIN IMMEDIATE`) and run one at a time, so they
  are serializable; other processes using the same file wait for the lock (`busyTimeoutMs`).
- Reads outside a transaction use a second, read-only connection in WAL mode, so they only ever see
  committed data. That needs a real file: for an in-memory store use `MemoryStore` from `nostro`.
- Amounts are stored as decimal text and constrained to positive integers, so values beyond 64 bits
  stay exact. Text memos are stored as BLOBs so NUL survives.
- `synchronous = FULL`: a committed transaction survives power loss.

**Use one `SqliteStore` per database file per process.** better-sqlite3 is synchronous, so two
instances in one process would wait on each other's write lock inside SQLite with no way to yield.
Separate processes are fine.

**Status:** 0.1.0, early: tested, and run against real testnet accounts, but the API may change before 1.0.
