import { describe, expect, it } from 'vitest'
import { buildAniListBrowserAuthUrl } from './browserAuth'

describe('AniList browser authorization', () => {
  it('uses the implicit grant for a public browser client without exposing a secret', () => {
    const url = new URL(buildAniListBrowserAuthUrl(' 43411 '))
    expect(url.origin + url.pathname).toBe('https://anilist.co/api/v2/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('43411')
    expect(url.searchParams.get('response_type')).toBe('token')
    expect(url.searchParams.has('client_secret')).toBe(false)
  })

  it('rejects missing or malformed client IDs', () => {
    expect(() => buildAniListBrowserAuthUrl('')).toThrow('valid AniList client ID')
    expect(() => buildAniListBrowserAuthUrl('https://attacker.example')).toThrow('valid AniList client ID')
  })
})
