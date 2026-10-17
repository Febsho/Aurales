import { describe, expect, it } from 'vitest'
import { getFlatpakInstallCommand } from './updater'

describe('Flatpak update instructions', () => {
  it('reinstalls the versioned standalone release bundle', () => {
    expect(getFlatpakInstallCommand('0.2.6')).toBe(
      'flatpak install --reinstall ~/Downloads/Aurales_0.2.6_amd64.flatpak',
    )
  })
})
