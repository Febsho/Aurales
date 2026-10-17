/** Sort timestamp strings by their represented instant, newest first. */
export function compareTimestampsNewestFirst(left?: string | null, right?: string | null): number {
  const leftTime = left ? Date.parse(left) : Number.NaN
  const rightTime = right ? Date.parse(right) : Number.NaN
  const leftValid = Number.isFinite(leftTime)
  const rightValid = Number.isFinite(rightTime)
  if (leftValid && rightValid) return rightTime - leftTime
  if (leftValid) return -1
  if (rightValid) return 1
  return String(right || '').localeCompare(String(left || ''))
}
