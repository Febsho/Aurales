import { describe, expect, it } from 'vitest'
import { getProfileAvatar, profileAvatars, searchProfileAvatars } from './index'

describe('profile avatar catalog', () => {
  it('contains stable, unique avatar references', () => {
    expect(profileAvatars.length).toBeGreaterThan(900)
    expect(new Set(profileAvatars.map((avatar) => avatar.id)).size).toBe(profileAvatars.length)
  })

  it('resolves and searches the local catalog without a network request', () => {
    const avatar = profileAvatars[0]
    expect(getProfileAvatar({ source: 'netflix-retired', avatarId: avatar.id })).toMatchObject({ id: avatar.id })
    expect(searchProfileAvatars(avatar.name).some((item) => item.id === avatar.id)).toBe(true)
  })
})
