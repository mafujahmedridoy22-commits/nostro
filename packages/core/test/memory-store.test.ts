import { describe, expect, it } from 'vitest'
import { MemoryStore, Money, NATIVE } from '../src/index.js'
import { describeStoreConformance, describeStoreProperties } from 'nostro-testkit'

describeStoreConformance('MemoryStore', () => new MemoryStore())
describeStoreProperties('MemoryStore', (now) => new MemoryStore({ now }), { runs: 200 })

describe('MemoryStore', () => {
  it('uses injected ids and clock so fixture runs are deterministic', async () => {
    let n = 0
    const at = new Date('2026-10-06T09:00:00Z')
    const store = new MemoryStore({ ids: () => `id-${++n}`, now: () => at })
    const e = await store.transaction((tx) =>
      tx.insertExpectation({
        tenantId: 't',
        reference: 'R-1',
        account: `G${'A'.repeat(55)}`,
        amount: Money.parse('1', NATIVE),
      }),
    )
    expect(e.id).toBe('id-1')
    expect(e.createdAt).toEqual(at)
  })

  it('keeps serving transactions after one fails', async () => {
    const store = new MemoryStore()
    await expect(store.transaction(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(store.transaction(async () => 'ok')).resolves.toBe('ok')
  })
})
