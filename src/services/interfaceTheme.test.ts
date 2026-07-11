import { describe, expect, it } from 'vitest'
import { INTERFACE_THEME_KEY, loadInterfaceTheme, persistInterfaceTheme } from './interfaceTheme'

describe('interface theme persistence', () => {
  it('defaults safely for missing and invalid values', () => {
    expect(loadInterfaceTheme({ getItem: () => null })).toBe('default')
    expect(loadInterfaceTheme({ getItem: () => 'unknown' })).toBe('default')
  })

  it('persists and restores the cinematic theme', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    persistInterfaceTheme('cinematic', storage)
    expect(values.get(INTERFACE_THEME_KEY)).toBe('cinematic')
    expect(loadInterfaceTheme(storage)).toBe('cinematic')
  })
})
