import type { AmbientColor } from '../ambientColor'

export const POSTER_COLOR_GROUPS = [
  { id: 'red', label: 'Red', hue: 0, color: '#ed5757' },
  { id: 'orange', label: 'Orange', hue: 30, color: '#f59a45' },
  { id: 'yellow', label: 'Yellow', hue: 55, color: '#e7c74d' },
  { id: 'green', label: 'Green', hue: 120, color: '#67bd83' },
  { id: 'blue', label: 'Blue', hue: 215, color: '#6099ec' },
  { id: 'purple', label: 'Purple', hue: 280, color: '#a87be4' },
  { id: 'monochrome', label: 'Mono', hue: 360, color: '#bfc1c8' },
] as const

export type PosterColorGroup = typeof POSTER_COLOR_GROUPS[number]['id']

export interface PosterColorSample<T> {
  item: T
  color: PosterColorGroup
}

/** Filter artwork without disturbing the popularity order of its source list. */
export function selectPosterColorItems<T>(
  samples: readonly PosterColorSample<T>[],
  selected: PosterColorGroup | 'all',
): T[] {
  return samples
    .filter(({ color }) => selected === 'all' || color === selected)
    .map(({ item }) => item)
}

export function classifyPosterColor({ r, g, b }: AmbientColor): PosterColorGroup {
  const red = r / 255
  const green = g / 255
  const blue = b / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  const saturation = max === 0 ? 0 : delta / max
  if (saturation < 0.16) return 'monochrome'

  let hue: number
  if (max === red) hue = 60 * (((green - blue) / delta) % 6)
  else if (max === green) hue = 60 * ((blue - red) / delta + 2)
  else hue = 60 * ((red - green) / delta + 4)
  if (hue < 0) hue += 360

  if (hue < 15 || hue >= 345) return 'red'
  if (hue < 42) return 'orange'
  if (hue < 70) return 'yellow'
  if (hue < 165) return 'green'
  if (hue < 255) return 'blue'
  return 'purple'
}
