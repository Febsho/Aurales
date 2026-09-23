export interface ResumeState {
  progressSeconds: number
  durationSeconds: number
}

export function formatTimeLeft(seconds: number): string {
  const totalMinutes = Math.max(1, Math.ceil(Math.max(0, seconds) / 60))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours <= 0) return `${minutes}m left`
  return minutes > 0 ? `${hours}h ${minutes}m left` : `${hours}h left`
}

export function moviePrimaryLabel(watched: boolean, resume?: ResumeState | null): string {
  if (watched) return 'Watch Again'
  if (resume) return `Resume • ${formatTimeLeft(resume.durationSeconds - resume.progressSeconds)}`
  return 'Play'
}

export function seriesPrimaryLabel(options: {
  allWatched: boolean
  resume?: { season: number; episode: number } | null
  next?: { seasonNumber: number; episodeNumber: number } | null
  hasHistory: boolean
}): string {
  if (options.allWatched) return 'Watch Again'
  if (options.resume) return `Continue S${options.resume.season} E${options.resume.episode}`
  if (options.hasHistory && options.next) return `Next Episode • S${options.next.seasonNumber} E${options.next.episodeNumber}`
  return 'Play'
}

export function promoteDecodedArtwork(current: string | undefined, candidate: string, decoded: boolean): {
  current: string | undefined
  previous?: string
} {
  if (!decoded || !candidate || candidate === current) return { current }
  return { current: candidate, previous: current }
}
