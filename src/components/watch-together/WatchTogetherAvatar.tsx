import { useState } from 'react'
import { getActiveProfile } from '../../services/profiles'
import { cachedImage, retryImageFromSource } from '../../services/imageCache'
import type { RoomParticipant } from '../../services/watch-together/types'
import ProfileAvatar from '../profiles/ProfileAvatar'

interface WatchTogetherAvatarProps {
  participant?: RoomParticipant
  name: string
  isCurrentUser?: boolean
  className?: string
}

/**
 * The room protocol only carries a shareable image URL. The local participant
 * can do better: render their selected Aurales profile avatar directly, so it
 * never falls back to an initial when a room was created before the avatar was
 * cached or the server has not echoed an update yet.
 */
export default function WatchTogetherAvatar({ participant, name, isCurrentUser = false, className = '' }: WatchTogetherAvatarProps) {
  const [imageFailed, setImageFailed] = useState(false)
  const profile = getActiveProfile()

  if (isCurrentUser) {
    return <ProfileAvatar {...profile} size="sm" className={`!h-full !w-full !rounded-[inherit] ${className}`} />
  }

  if (participant?.avatar && !imageFailed) {
    const source = participant.avatar
    return (
      <img
        src={cachedImage(source)}
        alt={`${name}'s avatar`}
        onError={(event) => { if (!retryImageFromSource(event.currentTarget, source)) setImageFailed(true) }}
        className={`h-full w-full object-cover ${className}`}
      />
    )
  }

  return <span aria-label={`${name} avatar`} className={`grid h-full w-full place-items-center ${className}`}>{name.charAt(0).toUpperCase() || '?'}</span>
}
