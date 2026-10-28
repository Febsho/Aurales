import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { check } from '@tauri-apps/plugin-updater'
import { canSelfUpdate, checkForUpdate, downloadAndInstall, getFlatpakInstallCommand } from './updater'

beforeEach(() => vi.stubGlobal('window', {}))
afterEach(() => vi.unstubAllGlobals())

describe('Flatpak update instructions', () => {
  it('reinstalls the versioned standalone release bundle', () => {
    expect(getFlatpakInstallCommand('0.2.6')).toBe(
      'flatpak install --reinstall ~/Downloads/Aurales_0.2.6_amd64.flatpak',
    )
  })
})

describe('browser update behavior', () => {
  it('uses site redeployment instead of invoking the native updater', async () => {
    await expect(checkForUpdate()).resolves.toBeNull()
    await expect(canSelfUpdate()).resolves.toBe(false)
    await expect(downloadAndInstall()).rejects.toThrow('Browser deployments update')
    expect(check).not.toHaveBeenCalled()
  })
})
