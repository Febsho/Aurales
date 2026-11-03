/** Keep scripted scrolling consistent with the user's reduced-motion setting. */
export function preferredScrollBehavior(
  reducedMotion = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
): ScrollBehavior {
  return reducedMotion ? 'auto' : 'smooth'
}
