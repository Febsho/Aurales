import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HomeRowConfig, SearchResult } from '../../types'
import {
  clearContinueWatchingSnapshotsForSource,
  getContinueWatchingAccountScope,
  mergeContinueWatchingPresentation,
  readContinueWatchingStartupSnapshot,
  readHeroStartupSnapshot,
  rotateProviderCredentialScope,
  stableListFingerprint,
  writeContinueWatchingStartupSnapshot,
  writeHeroStartupSnapshot,
  type ContinueWatchingSnapshotItem,
} from './homeStartupSnapshot'

const values = new Map<string, string>()
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value) },
  removeItem: (key: string) => { values.delete(key) },
}

const heroRow = (catalogId = 'popular'): HomeRowConfig => ({
  id: 'hero', title: 'Featured', layout: 'hero', enabled: true, order: 0,
  addonId: 'addon', addonUrl: 'https://example.com/manifest.json', catalogType: 'movie', catalogId,
})

const heroItem = (id: string): SearchResult => ({ id, title: `Title ${id}`, type: 'movie', provider: 'addon', backdrop: `https://img/${id}.jpg` })
const continueItem = (id: string): ContinueWatchingSnapshotItem => ({
  id, mediaId: id, mediaType: 'series', title: `Show ${id}`, poster: `https://img/${id}.jpg`,
  progressSeconds: 60, durationSeconds: 1200, progressPct: 5, updatedAt: '2026-07-14T00:00:00Z',
})

describe('Home startup snapshots', () => {
  beforeEach(() => {
    values.clear()
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
    vi.stubGlobal('crypto', { randomUUID: () => 'scope-id' })
  })

  it('reads a matching Hero snapshot synchronously and rejects a changed row', () => {
    writeHeroStartupSnapshot(heroRow(), [heroItem('1')])
    expect(readHeroStartupSnapshot(heroRow())).toEqual([heroItem('1')])
    expect(readHeroStartupSnapshot(heroRow('trending'))).toBeNull()
  })

  it('caps snapshots at fifteen items and ignores malformed storage', () => {
    writeHeroStartupSnapshot(heroRow(), Array.from({ length: 20 }, (_, index) => heroItem(String(index))))
    expect(readHeroStartupSnapshot(heroRow())).toHaveLength(15)
    values.set('aurales_home_startup_snapshots_v1', '{broken')
    expect(readHeroStartupSnapshot(heroRow())).toBeNull()
  })

  it('scopes Continue Watching by account and limit', () => {
    writeContinueWatchingStartupSnapshot('trakt', 'trakt:alice', 10, [continueItem('1')])
    expect(readContinueWatchingStartupSnapshot('trakt', 'trakt:alice', 10)).toHaveLength(1)
    expect(readContinueWatchingStartupSnapshot('trakt', 'trakt:bob', 10)).toBeNull()
    expect(readContinueWatchingStartupSnapshot('trakt', 'trakt:alice', 5)).toBeNull()
    clearContinueWatchingSnapshotsForSource('trakt')
    expect(readContinueWatchingStartupSnapshot('trakt', 'trakt:alice', 10)).toBeNull()
  })

  it('requires provider identity and rotates opaque credential scopes', () => {
    values.set('trakt_tokens', '{}')
    expect(getContinueWatchingAccountScope('trakt')).toBeNull()
    values.set('trakt_account', JSON.stringify({ username: 'alice' }))
    expect(getContinueWatchingAccountScope('trakt')).toBe('trakt:alice')

    values.set('pmdb_api_key', 'secret')
    rotateProviderCredentialScope('pmdb', true)
    expect(getContinueWatchingAccountScope('pmdb')).toBe('pmdb:scope-id')
    rotateProviderCredentialScope('pmdb', false)
    values.delete('pmdb_api_key')
    expect(getContinueWatchingAccountScope('pmdb')).toBeNull()
  })

  it('fingerprints stable media identity and order, not metadata', () => {
    const original = [{ ...heroItem('one'), tmdbId: 7 }, { ...heroItem('two'), imdbId: 'tt2' }]
    const metadataChanged = [{ ...original[0], title: 'Renamed' }, { ...original[1], poster: 'new' }]
    expect(stableListFingerprint(original)).toBe(stableListFingerprint(metadataChanged))
    expect(stableListFingerprint(original)).not.toBe(stableListFingerprint([...metadataChanged].reverse()))
  })

  it('reuses cached presentation while keeping fresh progress', () => {
    const cached = { ...continueItem('old'), mediaId: 'tt123', imdbId: 'tt123', title: 'Real title', backdrop: 'cached-backdrop' }
    const fresh = { ...continueItem('new'), mediaId: 'tt123', imdbId: 'tt123', title: 'Untitled', poster: undefined, backdrop: undefined, progressPct: 42 }
    expect(mergeContinueWatchingPresentation([fresh], [cached])[0]).toMatchObject({
      title: 'Real title', backdrop: 'cached-backdrop', progressPct: 42,
    })
  })
})
