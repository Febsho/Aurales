export type MediaRowScrollDirection = 'left' | 'right'

interface MediaRowScrollTargetOptions {
  cardStarts: readonly number[]
  current: number
  maxScroll: number
  direction: MediaRowScrollDirection
  cardsPerPage: number
}

/**
 * Move a shelf by up to two cards while keeping the motion predictable across
 * phone and desktop layouts. Include the real scroll edge as a stop so the
 * final move never targets beyond content the browser can actually display.
 */
export function getMediaRowScrollTarget({ cardStarts, current, maxScroll, direction, cardsPerPage }: MediaRowScrollTargetOptions): number | null {
  const max = Math.max(0, Number.isFinite(maxScroll) ? maxScroll : 0)
  if (max <= 1) return 0

  const stops = [...cardStarts, max]
    .filter(Number.isFinite)
    .map((start) => Math.max(0, Math.min(max, start)))
    .sort((left, right) => left - right)
    .filter((start, index, values) => index === 0 || start - values[index - 1]! > 1)
  if (!stops.length || stops[0]! > 1) stops.unshift(0)

  const position = Math.max(0, Math.min(max, Number.isFinite(current) ? current : 0))
  let currentIndex = 0
  for (let index = 1; index < stops.length; index += 1) {
    if (Math.abs(stops[index]! - position) < Math.abs(stops[currentIndex]! - position)) currentIndex = index
  }

  const pageStep = Math.max(1, Math.min(2, Math.floor(cardsPerPage) - 1))
  const nextIndex = Math.max(0, Math.min(stops.length - 1, currentIndex + (direction === 'right' ? pageStep : -pageStep)))
  const target = stops[nextIndex]!
  if (Math.abs(target - position) > 1) return target

  // A partially visible final card can share its clamped start with the
  // current position. Fall through to the nearest strictly forward stop.
  const alternative = direction === 'right'
    ? stops.find((stop) => stop > position + 1)
    : [...stops].reverse().find((stop) => stop < position - 1)
  return alternative ?? (direction === 'right' ? max : 0)
}
