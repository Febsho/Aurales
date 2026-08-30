import { useEffect, useState } from 'react'
import { PROFILE_SWITCH_TRANSITION_KEY, type AuralesProfile } from '../services/profiles'
import ProfileAvatar from './profiles/ProfileAvatar'

function readTransitionProfile(): AuralesProfile | null {
  try {
    const value = sessionStorage.getItem(PROFILE_SWITCH_TRANSITION_KEY)
    sessionStorage.removeItem(PROFILE_SWITCH_TRANSITION_KEY)
    if (!value) return null
    const profile = JSON.parse(value) as AuralesProfile
    return profile?.id && profile?.name ? profile : null
  } catch {
    return null
  }
}

/** A brief, calm handoff while a selected profile's isolated state reloads. */
export default function ProfileSwitchTransition() {
  const [profile] = useState(readTransitionProfile)
  const [visible, setVisible] = useState(false)
  const [complete, setComplete] = useState(!profile)

  useEffect(() => {
    if (!profile) return
    const frame = requestAnimationFrame(() => setVisible(true))
    const finish = window.setTimeout(() => setVisible(false), 950)
    const remove = window.setTimeout(() => setComplete(true), 1300)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(finish)
      window.clearTimeout(remove)
    }
  }, [profile])

  if (!profile || complete) return null
  return (
    <div aria-live="polite" aria-label={`Switching to ${profile.name}`} className={`profile-switch-transition ${visible ? 'is-visible' : ''}`}>
      <div className="profile-switch-transition__veil" />
      <div className="profile-switch-transition__identity">
        <div className="profile-switch-transition__avatar"><ProfileAvatar {...profile} size="lg" className="!h-24 !w-24 !rounded-[30%]" /></div>
        <p className="profile-switch-transition__name">{profile.name}</p>
      </div>
    </div>
  )
}
