# @nostro-labs/store-postgres

PostgreSQL store for [nostro](https://github.com/nostro-labs/nostro). Passes the same Store
conformance suite as nostro's in-memory store.

```sh
npm install @nostro-labs/nostro @nostro-labs/store-postgres
```

```ts
import { PostgresStore } from '@nostro-labs/store-postgres'

const store = new PostgresStore({ connectionString: process.env.DATABASE_URL, schema: 'nostro' })
await store.migrate() // creates the schema and applies pending migrations; safe to run concurrently
```

- Amounts are `NUMERIC(40,0)` raw units plus decimals, never floats.
- Uniqueness, positive amounts and closed value sets are enforced by the database as well as in code.
- Concurrent workers are safe: rows a write depends on are locked with `SELECT … FOR UPDATE`, and a
  cursor read inside a transaction holds that cursor until the transaction ends.
- Text memos are stored as bytes, because a Stellar text memo can contain NUL and a PostgreSQL
  `text` column cannot.

Pass `pool` instead of `connectionString` to share a pool you manage; the store will not end it.

**Status:** 0.1.0, early: tested, and run against real testnet accounts, but the API may change before 1.0.
