# @nostro-labs/server

An HTTP API over a [nostro](https://github.com/nostro-labs/nostro) store: list movements,
expectations, exceptions and journal entries, record expectations, and download the journal as CSV.
It holds no reconciliation logic of its own; run `sync()` and `reconcile()` (or `nostro sync` and
`nostro reconcile`) beside it.

```sh
npm install @nostro-labs/nostro @nostro-labs/server
```

```ts
import { SqliteStore } from '@nostro-labs/store-sqlite'
import { apiKeys, createServer } from '@nostro-labs/server'

const store = new SqliteStore({ filename: './nostro.db' })
const app = createServer({ store, authenticate: apiKeys({ [process.env.ACME_API_KEY!]: 'acme' }) })
await app.listen({ port: 8080 })
```

| Route | |
|---|---|
| `GET /v1/health` | `{ "ok": true }`; needs no key |
| `GET /v1/openapi.json` | the OpenAPI 3.1 document for all of this; needs no key |
| `GET /v1/movements` | `?disposition=`, `?account=` |
| `GET /v1/movements/{id}` | the movement, its allocations, exceptions and journal entries |
| `GET /v1/expectations` | `?status=open,partially_paid`, `?account=` |
| `GET /v1/expectations/{id}` | the expectation and its allocations |
| `POST /v1/expectations` | record one; `201` with `Location`, `409` if the reference is taken |
| `GET /v1/exceptions` | `?status=`, `?code=` |
| `POST /v1/exceptions/{id}/resolve` | decide it: `{ "action": "apply", "allocations": [{ "reference": "INV-1" }], "note": "..." }`, `{ "action": "ignore", "note": "..." }` or `{ "action": "close", "note": "..." }`; see [When a person decides](../../docs/matching.md#when-a-person-decides) |
| `GET /v1/journal` | `?from=`, `?to=` (ISO 8601, effective dates) |
| `GET /v1/journal.csv` | the journal as CSV, streamed |
| `GET /v1/events` | the event log ([docs/webhooks.md](../../docs/webhooks.md)), for clients that would rather poll than receive webhooks |

- **Authentication.** `Authorization: Bearer <key>`. The key decides the tenant, so a caller can never
  ask for another tenant's records. `apiKeys()` keeps only SHA-256 digests of the keys, compares in
  constant time, and refuses keys shorter than 32 characters (`openssl rand -hex 32`).
- **Paging.** Lists return `{ "data": [...], "next": <seq> | null }`; pass `next` back as `?after=`.
  `?limit=` is 1 to 500 (default 100).
- **Amounts** are exact decimal strings beside their asset (`"amount": "25.0000000", "asset":
  "native"`), never JSON numbers, in both directions: a request body containing any number is
  refused, because by the time it is parsed it may already have been rounded.
- **Errors** are RFC 9457 problem details (`application/problem+json`) with a stable `code`:
  `unauthorized`, `invalid_request` (400), `not_found`, `reference_taken` (409),
  `invalid_expectation` (422, e.g. an amount with more decimals than the asset has),
  `invalid_resolution` (422), `resolution_refused` (409, the rules refuse it), `internal`. A
  query parameter or body field the API does not know is a 400, not silently ignored. A 500 says
  nothing about the server's insides.

The OpenAPI document is built from the same schemas the server validates requests with, and tests
check that it is valid, lists exactly the routes the server has, and matches real responses,
errors included.

Not here yet: a container image. Webhooks are delivered by `nostro serve --webhook-url`, or by calling `deliverWebhooks()` from `nostro`.

**Status:** 0.1.0, early: tested, and run against real testnet accounts, but the API may change before 1.0.
