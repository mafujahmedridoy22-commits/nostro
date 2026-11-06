/**
 * The API's schemas, in one place: the server validates requests with them,
 * and the OpenAPI document is built from them, so the two cannot disagree.
 * The response schemas describe nostro's JSON wire format (`model/json.ts`
 * in core); a test checks real responses against them.
 */
import {
  DISPOSITIONS,
  EVENT_TYPES,
  EXCEPTION_CODES,
  EXPECTATION_STATUSES,
  JOURNAL_ENTRY_KINDS,
  LINE_ROLES,
  MOVEMENT_KINDS,
} from '@nostro-labs/nostro'
import type { ProblemCode } from './problem.js'

export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 500
export const ACCOUNT = '^G[A-Z2-7]{55}$'
export const UINT64 = '^[0-9]{1,20}$'
const AMOUNT = '^[0-9]+(\\.[0-9]+)?$'

const paging = {
  after: { type: 'integer', minimum: 0, description: 'Return records after this `seq`: the `next` of the previous page.' },
  limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
} as const

const range = {
  from: { type: 'string', format: 'date-time', description: 'Effective on or after this instant.' },
  to: { type: 'string', format: 'date-time', description: 'Effective strictly before this instant.' },
} as const

const listQuery = (properties: Record<string, unknown>) =>
  ({ type: 'object', additionalProperties: false, properties: { ...paging, ...properties } }) as const

const statuses = EXPECTATION_STATUSES.join('|')

/** Path parameters: an id with a NUL cannot name anything, and PostgreSQL would refuse to look. */
export const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[^\\u0000]+$' } },
} as const

/** Querystring schemas, by route. */
export const query = {
  movements: listQuery({
    disposition: { enum: [...DISPOSITIONS] },
    account: { type: 'string', pattern: ACCOUNT },
  }),
  expectations: listQuery({
    status: { type: 'string', pattern: `^(${statuses})(,(${statuses}))*$`, description: 'One or more, comma separated.' },
    account: { type: 'string', pattern: ACCOUNT },
  }),
  exceptions: listQuery({
    status: { enum: ['open', 'resolved', 'dismissed'] },
    code: { enum: [...EXCEPTION_CODES] },
  }),
  events: listQuery({}),
  journal: listQuery(range),
  journalCsv: { type: 'object', additionalProperties: false, properties: range },
} as const

export const expectationBody = {
  type: 'object',
  additionalProperties: false,
  required: ['reference', 'account', 'amount'],
  properties: {
    reference: { type: 'string', minLength: 1, maxLength: 256, description: 'Yours, unique within the tenant.' },
    account: { type: 'string', pattern: ACCOUNT },
    amount: { type: 'string', pattern: AMOUNT, description: 'A decimal string, never a JSON number; never rounded.' },
    asset: { type: 'string', minLength: 1, description: '`native` (the default) or `CODE:ISSUER`.' },
    direction: { enum: ['credit', 'debit'] },
    muxedId: { type: 'string', pattern: UINT64 },
    memo: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'value'],
      properties: { type: { enum: ['text', 'id'] }, value: { type: 'string', minLength: 1 } },
    },
    payers: { type: 'array', maxItems: 100, items: { type: 'string', pattern: ACCOUNT } },
    dueAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time' },
    metadata: { type: 'object', maxProperties: 50, additionalProperties: { type: 'string', maxLength: 1024 } },
  },
} as const

export const resolveBody = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'allocations', 'note'],
      properties: {
        action: { const: 'apply' },
        allocations: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['reference'],
            properties: {
              reference: { type: 'string', minLength: 1, maxLength: 256 },
              amount: { type: 'string', pattern: AMOUNT, description: 'Without one: what is left of the movement and still owing.' },
            },
          },
        },
        note: { type: 'string', minLength: 1, maxLength: 2000 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'note'],
      properties: { action: { const: 'ignore' }, note: { type: 'string', minLength: 1, maxLength: 2000 } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'note'],
      properties: {
        action: { const: 'close' },
        status: { enum: ['resolved', 'dismissed'], description: 'Default `resolved`.' },
        note: { type: 'string', minLength: 1, maxLength: 2000 },
      },
    },
  ],
} as const

// Responses.

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] })
const str = { type: 'string' }
const int = { type: 'integer' }
const time = { type: 'string', format: 'date-time' }
const amount = { type: 'string', pattern: AMOUNT }
const record = (properties: Record<string, object>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
})

const PROBLEM_CODES: readonly ProblemCode[] = [
  'unauthorized',
  'invalid_request',
  'invalid_expectation',
  'invalid_resolution',
  'resolution_refused',
  'not_found',
  'reference_taken',
  'internal',
]

export const components = {
  Memo: record({ type: { enum: ['text', 'id', 'hash', 'return'] }, value: str }),
  Movement: record({
    id: str,
    seq: int,
    network: str,
    source: str,
    externalId: str,
    revision: int,
    account: str,
    direction: { enum: ['credit', 'debit'] },
    kind: { enum: [...MOVEMENT_KINDS] },
    amount,
    asset: str,
    counterparty: nullable(str),
    muxedId: nullable({ type: 'string', pattern: UINT64 }),
    memo: nullable(ref('Memo')),
    ledger: int,
    txHash: nullable(str),
    operationId: nullable(str),
    occurredAt: time,
    enrichment: { enum: ['complete', 'missing'] },
    disposition: { enum: [...DISPOSITIONS] },
    ignoredReason: nullable(str),
    createdAt: time,
  }),
  Expectation: record({
    id: str,
    seq: int,
    reference: str,
    account: str,
    direction: { enum: ['credit', 'debit'] },
    amount,
    asset: str,
    muxedId: nullable({ type: 'string', pattern: UINT64 }),
    memo: nullable(ref('Memo')),
    payers: { type: 'array', items: str },
    dueAt: nullable(time),
    expiresAt: nullable(time),
    status: { enum: [...EXPECTATION_STATUSES] },
    cancelReason: nullable(str),
    metadata: { type: 'object', additionalProperties: str },
    createdAt: time,
    updatedAt: time,
  }),
  Allocation: record({
    id: str,
    movementId: str,
    expectationId: str,
    amount,
    asset: str,
    strategy: str,
    score: nullable({ type: 'number', minimum: 0, maximum: 1 }),
    createdAt: time,
  }),
  Exception: record({
    id: str,
    seq: int,
    code: { enum: [...EXCEPTION_CODES] },
    status: { enum: ['open', 'resolved', 'dismissed'] },
    movementId: nullable(str),
    expectationId: nullable(str),
    account: nullable(str),
    amount: nullable(amount),
    asset: nullable(str),
    detail: str,
    evidence: { description: 'Why the engine decided what it did; any JSON.' },
    openedAt: time,
    resolvedAt: nullable(time),
    resolutionNote: nullable(str),
  }),
  JournalLine: record({
    account: str,
    role: { enum: [...LINE_ROLES] },
    side: { enum: ['debit', 'credit'] },
    amount,
    asset: str,
    expectationId: nullable(str),
    exceptionId: nullable(str),
  }),
  JournalEntry: record({
    id: str,
    seq: int,
    movementId: nullable(str),
    postingNo: nullable(int),
    kind: { enum: [...JOURNAL_ENTRY_KINDS] },
    effectiveAt: time,
    postedAt: time,
    description: str,
    lines: { type: 'array', items: ref('JournalLine') },
  }),
  Event: record({
    id: str,
    seq: int,
    type: { enum: [...EVENT_TYPES] },
    subjectId: str,
    createdAt: time,
    data: { type: 'object', description: 'The records the event is about, as they were; see docs/webhooks.md.' },
  }),
  MovementDetail: record({
    movement: ref('Movement'),
    allocations: { type: 'array', items: ref('Allocation') },
    exceptions: { type: 'array', items: ref('Exception') },
    journal: { type: 'array', items: ref('JournalEntry') },
  }),
  ExpectationDetail: record({
    expectation: ref('Expectation'),
    allocations: { type: 'array', items: ref('Allocation') },
  }),
  Resolution: record({
    movement: nullable(ref('Movement')),
    allocations: { type: 'array', items: ref('Allocation') },
    closed: { type: 'array', items: ref('Exception') },
    opened: nullable(ref('Exception')),
    journalEntry: nullable(ref('JournalEntry')),
  }),
  Problem: record({
    type: { const: 'about:blank' },
    title: str,
    status: int,
    code: { enum: [...PROBLEM_CODES] },
    detail: str,
  }),
  ...Object.fromEntries(
    ['Movement', 'Expectation', 'Exception', 'JournalEntry', 'Event'].map((name) => [
      `${name}Page`,
      record({ data: { type: 'array', items: ref(name) }, next: nullable(int) }),
    ]),
  ),
} as const

export { ref }
