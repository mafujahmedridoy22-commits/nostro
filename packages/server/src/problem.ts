/**
 * Errors as RFC 9457 problem details (`application/problem+json`), each with
 * a stable `code` a client can branch on.
 */

export type ProblemCode =
  | 'unauthorized'
  | 'invalid_request'
  | 'invalid_expectation'
  | 'invalid_resolution'
  | 'resolution_refused'
  | 'not_found'
  | 'reference_taken'
  | 'internal'

export interface Problem {
  readonly type: 'about:blank'
  readonly title: string
  readonly status: number
  readonly code: ProblemCode
  readonly detail: string
}

const TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Content',
  500: 'Internal Server Error',
}

export class HttpProblem extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ProblemCode,
    detail: string,
  ) {
    super(detail)
    this.name = 'HttpProblem'
  }

  toJSON(): Problem {
    return { type: 'about:blank', title: TITLES[this.status] ?? 'Error', status: this.status, code: this.code, detail: this.message }
  }
}
