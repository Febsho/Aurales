import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }))

import { invoke } from '@tauri-apps/api/core'
import { clearDiscordActivity, disconnectDiscord, setDiscordActivity } from './discord'

describe('Discord presence platform adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { __TAURI_INTERNALS__: undefined })
  })

  it('does not call desktop IPC from a browser', async () => {
    await setDiscordActivity({ details: 'Watching' })
    await clearDiscordActivity()
    await disconnectDiscord()

    expect(invoke).not.toHaveBeenCalled()
  })

  it('keeps using native IPC in the desktop app', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    await setDiscordActivity({ details: 'Watching', state: 'A film' })

    expect(invoke).toHaveBeenCalledWith('discord_set_activity', expect.objectContaining({ details: 'Watching', state: 'A film' }))
  })
})
