/**
 * The OpenAPI 3.1 document for the API, built from the same schemas the
 * server validates requests with. Served at `GET /v1/openapi.json`.
 */
import { readFileSync } from 'node:fs'
import { components, expectationBody, query, ref } from './schemas.js'

/** This package's version, which is the API's. */
const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ref('Problem') } },
})

const ok = (schemaName: string, description = 'OK') => ({
  description,
  content: { 'application/json': { schema: ref(schemaName) } },
})

const errors = {
  '400': problem('The request was malformed: an unknown or invalid parameter or field (`invalid_request`).'),
  '401': problem('No valid API key (`unauthorized`).'),
  '500': problem('Something failed inside the server (`internal`); the detail says nothing more.'),
}

/** Each property of a querystring schema, as an OpenAPI query parameter. */
function parameters(schema: { properties: Record<string, object> }) {
  return Object.entries(schema.properties).map(([name, s]) => ({ name, in: 'query', required: false, schema: s }))
}

const idParam = (what: string) => ({ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: `The ${what}'s id.` })

export function buildOpenApi() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'nostro',
      version: VERSION,
      summary: 'Payment reconciliation and ledger-to-accounting for Stellar.',
      description:
        'Every amount is an exact decimal string beside its asset, never a JSON number, in both directions. ' +
        'Lists page by `seq`: pass a response\'s `next` back as `after`. Errors are RFC 9457 problem details with a stable `code`.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    security: [{ apiKey: [] }],
    paths: {
      '/v1/health': {
        get: {
          operationId: 'health',
          summary: 'Liveness',
          security: [],
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object', required: ['ok'], properties: { ok: { const: true } } } } },
            },
          },
        },
      },
      '/v1/openapi.json': {
        get: {
          operationId: 'openapi',
          summary: 'This document',
          security: [],
          responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/v1/movements': {
        get: {
          operationId: 'listMovements',
          summary: 'Movements, in ingest order',
          parameters: parameters(query.movements),
          responses: { '200': ok('MovementPage'), ...errors },
        },
      },
      '/v1/movements/{id}': {
        get: {
          operationId: 'getMovement',
          summary: 'One movement, with its allocations, exceptions and journal entries',
          parameters: [idParam('movement')],
          responses: { '200': ok('MovementDetail'), '404': problem('No such movement in this tenant (`not_found`).'), ...errors },
        },
      },
      '/v1/expectations': {
        get: {
          operationId: 'listExpectations',
          summary: 'Expectations, in creation order',
          parameters: parameters(query.expectations),
          responses: { '200': ok('ExpectationPage'), ...errors },
        },
        post: {
          operationId: 'createExpectation',
          summary: 'Record what you are owed, or will pay',
          requestBody: { required: true, content: { 'application/json': { schema: expectationBody } } },
          responses: {
            '201': {
              ...ok('Expectation', 'Recorded'),
              headers: { Location: { description: 'Where it can be read back.', schema: { type: 'string' } } },
            },
            '409': problem('The reference is already used in this tenant (`reference_taken`).'),
            '422': problem('Well formed but not recordable exactly, e.g. more decimals than the asset has (`invalid_expectation`).'),
            ...errors,
          },
        },
      },
      '/v1/expectations/{id}': {
        get: {
          operationId: 'getExpectation',
          summary: 'One expectation, with what has been allocated to it',
          parameters: [idParam('expectation')],
          responses: { '200': ok('ExpectationDetail'), '404': problem('No such expectation in this tenant (`not_found`).'), ...errors },
        },
      },
      '/v1/exceptions': {
        get: {
          operationId: 'listExceptions',
          summary: 'Exceptions, in the order they were opened',
          parameters: parameters(query.exceptions),
          responses: { '200': ok('ExceptionPage'), ...errors },
        },
      },
      '/v1/events': {
        get: {
          operationId: 'listEvents',
          summary: 'The event log, the same events webhooks deliver',
          parameters: parameters(query.events),
          responses: { '200': ok('EventPage'), ...errors },
        },
      },
      '/v1/journal': {
        get: {
          operationId: 'listJournalEntries',
          summary: 'Journal entries, in posting order',
          parameters: parameters(query.journal),
          responses: { '200': ok('JournalEntryPage'), ...errors },
        },
      },
      '/v1/journal.csv': {
        get: {
          operationId: 'exportJournal',
          summary: 'The journal as CSV (RFC 4180), one row per line, streamed',
          parameters: parameters(query.journalCsv),
          responses: { '200': { description: 'CSV', content: { 'text/csv': { schema: { type: 'string' } } } }, ...errors },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', description: 'An API key; it decides the tenant.' },
      },
      schemas: components,
    },
  }
}
