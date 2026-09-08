/**
 * Keep track changes ordered without touching the playback lifecycle. mpv can
 * switch `aid` and `sid` in-place; serialising only these IPC writes prevents
 * rapid menu selections from being applied out of order by the native command
 * worker.
 */
export function createTrackPropertyQueue(
  send: (property: 'aid' | 'sid', value: number | 'no') => Promise<void>,
) {
  let tail: Promise<void> = Promise.resolve()

  return (property: 'aid' | 'sid', value: number | 'no'): Promise<void> => {
    const next = tail.catch(() => undefined).then(() => send(property, value))
    tail = next.catch(() => undefined)
    return next
  }
}
