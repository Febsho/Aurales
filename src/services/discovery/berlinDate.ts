const BERLIN_TIME_ZONE = 'Europe/Berlin'

function parts(date: Date): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: BERLIN_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
}

/** Calendar-day identity for the product's canonical timezone. Intl owns DST. */
export function getBerlinDateKey(now: Date = new Date()): string {
  const value = parts(now)
  return `${value.year}-${value.month}-${value.day}`
}

/** A stable daily integer for deterministic variety, without assuming a UTC offset. */
export function berlinDaySeed(now: Date = new Date()): number {
  let hash = 2166136261
  for (const char of getBerlinDateKey(now)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return hash >>> 0
}

/** Finds the next Berlin calendar boundary, including CET/CEST transitions. */
export function getNextBerlinMidnight(now: Date = new Date()): Date {
  const today = getBerlinDateKey(now)
  let upper = new Date(now.getTime() + 36 * 60 * 60 * 1000)
  while (getBerlinDateKey(upper) === today) upper = new Date(upper.getTime() + 6 * 60 * 60 * 1000)
  let lower = now.getTime()
  let high = upper.getTime()
  while (high - lower > 1000) {
    const middle = Math.floor((lower + high) / 2)
    if (getBerlinDateKey(new Date(middle)) === today) lower = middle
    else high = middle
  }
  return new Date(Math.floor(high / 1000) * 1000)
}
