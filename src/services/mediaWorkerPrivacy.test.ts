import { describe, expect, it } from 'vitest'
import { isProfileOwnedStorageKey } from './profiles'

describe('media worker credentials stay local to the installation', () => {
  it('excludes the private worker API key from profile backups and Aurales Sync', () => {
    expect(isProfileOwnedStorageKey('aurales_media_worker_secret_v1')).toBe(false)
  })
})
