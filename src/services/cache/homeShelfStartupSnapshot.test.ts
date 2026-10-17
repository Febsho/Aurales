import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HomeRowConfig, SearchResult } from '../../types'
import { readHomeShelfStartupSnapshot, writeHomeShelfStartupSnapshots } from './homeShelfStartupSnapshot'
import { homeRowCacheKey } from './homeRowCacheKeys'

const values = new Map<string, string>()
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value) },
  removeItem: (key: string) => { values.delete(key) },
}
const row = (id: string): HomeRowConfig => ({
  id, title: id, enabled: true, order: 0, layout: 'poster',
  addonId: 'addon', catalogType: 'movie', catalogId: id,
})
const item = (id: string): SearchResult => ({ id, title: id, type: 'movie', provider: 'tmdb', poster: `https://img/${id}` })

describe('Home shelf startup snapshots', () => {
  beforeEach(() => { values.clear(); vi.stubGlobal('localStorage', storage) })

  it('restores visible shelf metadata synchronously and isolates profiles', () => {
    const shelf = row('popular')
    const key = homeRowCacheKey(shelf)!
    values.set('aurales_active_profile_v1', 'alice')
    writeHomeShelfStartupSnapshots([shelf], () => [item('one')])
    expect(readHomeShelfStartupSnapshot(key)).toEqual([item('one')])
    values.set('aurales_active_profile_v1', 'bob')
    expect(readHomeShelfStartupSnapshot(key)).toBeNull()
  })

  it('keeps only the first three shelves and twelve cards per shelf', () => {
    const rows = ['a', 'b', 'c', 'd'].map((id, order) => ({ ...row(id), order }))
    writeHomeShelfStartupSnapshots(rows, () => Array.from({ length: 20 }, (_, index) => item(String(index))))
    expect(readHomeShelfStartupSnapshot(homeRowCacheKey(rows[0]))).toHaveLength(12)
    expect(readHomeShelfStartupSnapshot(homeRowCacheKey(rows[3]))).toBeNull()
  })
})
