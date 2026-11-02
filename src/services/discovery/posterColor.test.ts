import { describe, expect, it } from 'vitest'
import { classifyPosterColor, selectPosterColorItems } from './posterColor'

describe('classifyPosterColor', () => {
  it.each([
    [{ r: 220, g: 40, b: 45 }, 'red'],
    [{ r: 232, g: 116, b: 24 }, 'orange'],
    [{ r: 230, g: 210, b: 35 }, 'yellow'],
    [{ r: 32, g: 170, b: 72 }, 'green'],
    [{ r: 35, g: 90, b: 210 }, 'blue'],
    [{ r: 145, g: 48, b: 195 }, 'purple'],
    [{ r: 120, g: 124, b: 127 }, 'monochrome'],
  ] as const)('groups sampled poster color %o', (color, expected) => {
    expect(classifyPosterColor(color)).toBe(expected)
  })
})

describe('selectPosterColorItems', () => {
  const samples = [
    { item: 'most popular', color: 'blue' },
    { item: 'next popular', color: 'red' },
    { item: 'least popular', color: 'blue' },
  ] as const

  it('preserves popularity order when showing all colors', () => {
    expect(selectPosterColorItems([...samples], 'all')).toEqual([
      'most popular', 'next popular', 'least popular',
    ])
  })

  it('filters by color without reordering the matching titles', () => {
    expect(selectPosterColorItems([...samples], 'blue')).toEqual([
      'most popular', 'least popular',
    ])
  })
})
