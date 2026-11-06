# Events and webhooks

Every decision nostro makes is also written to an event log, in the same database transaction as the
decision. `deliverWebhooks()` posts that log to a URL, signed.

## The guarantee

An event exists if and only if its decision committed. So a webhook never announces a payment that
was rolled back, and a crash between deciding and notifying loses nothing: delivery reads the log
from a saved position and picks up where it stopped.

- **Order.** Events are delivered one at a time, in the order they were written. If one fails, the
  round stops there and the next round retries that same event, so nothing is skipped or reordered.
  In PostgreSQL, writers take a per-tenant lock before writing an event, so events commit in the
  order they are numbered.
- **At least once.** A crash after a receiver answered but before the position was saved sends that
  event again. Deduplicate on the event `id`.
- **Redirects are not followed.** A `3xx` counts as a failure: a signed body only goes to the URL you
  configured.

## Event types

| Type | When | `data` |
|---|---|---|
| `movement.decided` | a movement's disposition changed | `movement`, `previous` (the old disposition), `allocations` |
| `expectation.partially_paid` | an allocation part-paid an expectation | `expectation`, `allocation` |
| `expectation.settled` | an allocation paid it in full | `expectation`, `allocation` |
| `expectation.cancelled` | it was cancelled | `expectation`, `allocation: null` |
| `exception.opened` | something needs a person | `exception` |
| `exception.resolved`, `exception.dismissed` | someone closed it | `exception` |

Records use the same JSON as the HTTP API: amounts are exact decimal strings next to their asset,
and ids and dates are strings.

```json
{
  "id": "6f1c…",
  "seq": 42,
  "type": "expectation.settled",
  "subjectId": "0b9e…",
  "createdAt": "2026-10-22T12:00:00.000Z",
  "data": { "expectation": { "reference": "INV-1042", "amount": "25.0000000", "asset": "native", "status": "settled", "…": "…" }, "allocation": { "…": "…" } }
}
```

## Verifying a request

Each request carries `Nostro-Signature: t=<unix seconds>,v1=<hex>`: the HMAC-SHA256 of
`<t>.<raw body>` under your secret, plus `Nostro-Event-Id` and `Nostro-Event-Type` headers. Verify
the signature against the raw body before parsing it:

```ts
import { verifyWebhook } from '@nostro-labs/nostro'

const ok = verifyWebhook({ secret: process.env.NOSTRO_WEBHOOK_SECRET!, header: req.headers['nostro-signature'], body: rawBody })
if (!ok) return res.status(401).end()
```

`verifyWebhook()` compares in constant time and refuses a timestamp more than five minutes from now
(`toleranceSeconds`), so a captured request can't be replayed later. Answer with any `2xx` once the
event is safely stored on your side.

## Sending them

```ts
import { deliverWebhooks } from '@nostro-labs/nostro'

const report = await deliverWebhooks({ store, tenantId: 'acme', url: 'https://example.com/hooks/nostro', secret })
// { delivered, position, failure: { eventId, reason } | null, contended }
```

Like `sync()`, a call is bounded: run it on a timer, or let `nostro serve --webhook-url <url>` do it
after each round (the secret comes only from `NOSTRO_WEBHOOK_SECRET`). The HTTP API serves the same
log at `GET /v1/events` for clients that would rather poll. Secrets must be at least 32 characters
(`openssl rand -hex 32`). Each destination keeps its own position (`consumer`, default `webhook`).
Two deliverers sharing one consumer won't both advance it: the second one notices and stops.
