import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveHeroStreams } from './heroTrailerStreams'
import { getDirectYoutubeStream } from './youtubeDirect'

describe('browser trailer fallback', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('does not call desktop yt-dlp or localhost proxy IPC outside native mpv platforms', async () => {
    vi.stubGlobal('window', {})

    await expect(resolveHeroStreams('youtube-video-id')).resolves.toBeNull()
    await expect(getDirectYoutubeStream('youtube-video-id')).resolves.toBeNull()
  })
})
