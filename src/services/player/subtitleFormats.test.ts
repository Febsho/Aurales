import { describe, expect, it } from 'vitest'
import { subtitleToVtt } from './subtitleFormats'

describe('subtitleToVtt', () => {
  it('converts SRT timestamps and preserves cue text', () => {
    expect(subtitleToVtt('\uFEFF1\r\n00:00:01,250 --> 00:00:02,500\r\nHello\r\n'))
      .toBe('WEBVTT\n\n1\n00:00:01.250 --> 00:00:02.500\nHello\n')
  })

  it('preserves an existing WebVTT document', () => {
    expect(subtitleToVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello'))
      .toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello')
  })

  it('converts ASS dialogue cues, strips unsupported style blocks, and preserves commas in dialogue', () => {
    const ass = `[Script Info]\nTitle: Example\n\n[V4+ Styles]\nFormat: Name, Fontname\nStyle: Default,Arial\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.20,0:00:03.45,Default,,0,0,0,,{\\i1}Hello, world!\\NSecond line{\\i0}`
    expect(subtitleToVtt(ass)).toBe('WEBVTT\n\n00:00:01.200 --> 00:00:03.450\nHello, world!\nSecond line')
  })

  it('rejects formats it cannot safely convert instead of creating invalid WebVTT', () => {
    expect(() => subtitleToVtt('<tt><body>unsupported</body></tt>')).toThrow('cannot be rendered')
    expect(() => subtitleToVtt('[Script Info]\n[Events]\nFormat: Start, End, Text\n')).toThrow('no supported dialogue cues')
  })
})
