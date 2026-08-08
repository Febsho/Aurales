export interface KeyboardShortcut {
  keys: string[]
  label: string
  description?: string
}

export interface KeyboardShortcutSection {
  title: string
  shortcuts: KeyboardShortcut[]
}

export const KEYBOARD_SHORTCUT_SECTIONS: KeyboardShortcutSection[] = [
  {
    title: 'App & Navigation',
    shortcuts: [
      { keys: ['W'], label: 'Watch Together', description: 'Open or close the Watch Together panel from any browsing screen.' },
      { keys: ['/', 'Ctrl+K', '⌘K'], label: 'Focus search', description: 'Open search and focus its input.' },
      { keys: ['Alt+←'], label: 'Go back', description: 'Return to the previous screen.' },
      { keys: ['?'], label: 'Keyboard shortcuts', description: 'Open or close the shortcut overview.' },
      { keys: ['Esc'], label: 'Close', description: 'Close the active panel, dialog, menu, or fullscreen view.' },
    ],
  },
  {
    title: 'Cinematic Navigation',
    shortcuts: [
      { keys: ['← / →'], label: 'Move within a row' },
      { keys: ['↑ / ↓'], label: 'Move between rows' },
      { keys: ['Enter'], label: 'Open focused item' },
    ],
  },
  {
    title: 'Player — Playback',
    shortcuts: [
      { keys: ['Space'], label: 'Play / Pause' },
      { keys: ['F'], label: 'Toggle fullscreen' },
      { keys: ['M'], label: 'Mute / Unmute' },
      { keys: ['↑ / ↓'], label: 'Volume up / down' },
      { keys: ['Esc'], label: 'Close player menu / exit fullscreen' },
    ],
  },
  {
    title: 'Player — Seeking',
    shortcuts: [
      { keys: ['← / →'], label: 'Seek back / forward', description: 'Uses the seek step configured in Player settings.' },
      { keys: ['Hold ← / →'], label: 'Fast seek', description: 'Accelerates while the key remains pressed.' },
    ],
  },
]

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable
}

export function isWatchTogetherShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey'>): boolean {
  return event.key.toLowerCase() === 'w' && !event.ctrlKey && !event.altKey && !event.metaKey
}
