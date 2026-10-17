import { describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { resolveSeasonTitles, resolveSeasonTitlesWithNativeFallback } from './animeTitleResolver'

describe('anime season title compatibility', () => {
  it('keeps specials and avoids Japanese-only titles when configured', () => {
    expect(resolveSeasonTitles('Ignored', 0)).toEqual({ displayTitle: 'Specials' })
    expect(resolveSeasonTitles('進撃の巨人', 2, 'auto', false, true))
      .toEqual({ displayTitle: 'Season 2', nativeTitle: '進撃の巨人', originalTitle: '進撃の巨人' })
  })

  it('uses native season resolution and falls back to the legacy resolver', async () => {
    invoke.mockResolvedValueOnce({ displayTitle: 'Season 2', originalTitle: 'Provider title' })
    await expect(resolveSeasonTitlesWithNativeFallback('Provider title', 2, 'auto', true, true))
      .resolves.toEqual({ displayTitle: 'Season 2', originalTitle: 'Provider title' })
    expect(invoke).toHaveBeenCalledWith('resolve_anime_season_title', expect.anything())

    invoke.mockRejectedValueOnce(new Error('older application binary'))
    await expect(resolveSeasonTitlesWithNativeFallback('Provider title', 2, 'auto', true, true))
      .resolves.toEqual({ displayTitle: 'Season 2' })
  })
})
