import { afterEach, describe, expect, it, vi } from 'vitest'
import { isEditableKeyboardTarget, isWatchTogetherShortcut } from './keyboardShortcuts'

describe('keyboard shortcuts', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('matches an unmodified W key only', () => {
    expect(isWatchTogetherShortcut({ key: 'w', ctrlKey: false, altKey: false, metaKey: false })).toBe(true)
    expect(isWatchTogetherShortcut({ key: 'W', ctrlKey: false, altKey: false, metaKey: false })).toBe(true)
    expect(isWatchTogetherShortcut({ key: 'w', ctrlKey: true, altKey: false, metaKey: false })).toBe(false)
    expect(isWatchTogetherShortcut({ key: 'q', ctrlKey: false, altKey: false, metaKey: false })).toBe(false)
  })

  it('does not trigger app shortcuts while editing', () => {
    class FakeElement {
      tagName = 'INPUT'
      isContentEditable = false
    }
    vi.stubGlobal('HTMLElement', FakeElement)
    expect(isEditableKeyboardTarget(new FakeElement() as unknown as EventTarget)).toBe(true)
  })
})
