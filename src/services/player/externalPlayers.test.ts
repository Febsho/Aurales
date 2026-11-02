import { describe, expect, it } from 'vitest'
import { buildExternalPlayerUrl } from './externalPlayers'

describe('Android external player intents', () => {
  const cases = [
    ['nextplayer', 'dev.anilbeesetti.nextplayer'],
    ['mxplayer', 'com.mxtech.videoplayer.ad'],
    ['justplayer', 'com.brouken.player'],
    ['vlc', 'org.videolan.vlc'],
  ] as const

  it.each(cases)('%s targets its Android package and preserves the stream URL', (player, packageName) => {
    const result = buildExternalPlayerUrl(player, 'https://media.example/video.m3u8?token=abc', { title: 'A title' })
    expect(result).toBe('intent://media.example/video.m3u8?token=abc#Intent;scheme=https;type=video/*;package=' + packageName + ';S.title=A%20title;end')
  })

  it('rejects non-HTTP stream URLs', () => {
    expect(buildExternalPlayerUrl('vlc', 'file:///video.mp4')).toBeNull()
  })
})
