import { v4 as uuid } from 'uuid'

export interface AuralesProfile {
  id: string
  name: string
  avatar?: string
  accent?: string
  createdAt: string
  updatedAt: string
  isDefault?: boolean
}

const PROFILES_KEY = 'aurales_profiles_v1'
const ACTIVE_KEY = 'aurales_active_profile_v1'
export const PROFILE_CHANGED_EVENT = 'aurales:profile-changed'

// User-owned legacy keys which are safely copied to the initial profile.  Keep
// credentials and addon configuration global; those must never be silently
// duplicated or migrated between people.
const MIGRATED_KEYS = [
  'aurales_watch_progress', 'aurales_recently_viewed',
  'aurales_preferred_subtitles', 'aurales_preferred_audio', 'aurales_subtitle_mode',
  'aurales_local_watchlist_v1', 'aurales_discovery_feedback_v1',
  'aurales_stream_reliability_v1', 'aurales_stream_playback_memory_v1',
  'aurales_home_rows', 'aurales_discovery_starter_genres', 'aurales_discovery_mode',
]

function now() { return new Date().toISOString() }
function readProfiles(): AuralesProfile[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROFILES_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((value): value is AuralesProfile => Boolean(value?.id && value?.name)) : []
  } catch { return [] }
}
function writeProfiles(profiles: AuralesProfile[]) { localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles)) }
function queueProfileRecord(profileId: string, payload: AuralesProfile | { id: string; deleted: true }): void {
  // Keep profiles usable when the optional transport has not loaded yet, and
  // avoid making the profile store depend on a transport implementation.
  void import('./sync/auralesSync').then(({ enqueueSyncRecord }) => enqueueSyncRecord('profile', profileId, payload, profileId))
}

export function profileStorageKey(key: string, profileId = getActiveProfileId()): string {
  return `${key}:profile:${profileId}`
}

function migrateLegacyState(profileId: string): void {
  for (const key of MIGRATED_KEYS) {
    const scoped = profileStorageKey(key, profileId)
    if (localStorage.getItem(scoped) == null) {
      const legacy = localStorage.getItem(key)
      if (legacy != null) localStorage.setItem(scoped, legacy)
    }
  }
}

export function ensureProfiles(): AuralesProfile[] {
  const current = readProfiles()
  if (current.length) return current
  const profile: AuralesProfile = { id: uuid(), name: 'Default', createdAt: now(), updatedAt: now(), isDefault: true }
  writeProfiles([profile])
  localStorage.setItem(ACTIVE_KEY, profile.id)
  migrateLegacyState(profile.id)
  return [profile]
}

export function getProfiles(): AuralesProfile[] { return ensureProfiles() }
export function getActiveProfileId(): string {
  const profiles = ensureProfiles()
  const saved = localStorage.getItem(ACTIVE_KEY)
  return profiles.some((profile) => profile.id === saved) ? saved! : profiles[0].id
}
export function getActiveProfile(): AuralesProfile { return getProfiles().find((profile) => profile.id === getActiveProfileId()) || getProfiles()[0] }
export function setActiveProfile(profileId: string): boolean {
  if (!getProfiles().some((profile) => profile.id === profileId)) return false
  localStorage.setItem(ACTIVE_KEY, profileId)
  window.dispatchEvent(new CustomEvent(PROFILE_CHANGED_EVENT, { detail: { profileId } }))
  return true
}
export function createProfile(name: string, avatar?: string, accent?: string): AuralesProfile {
  const profile: AuralesProfile = { id: uuid(), name: name.trim().slice(0, 40) || 'Profile', avatar, accent, createdAt: now(), updatedAt: now() }
  writeProfiles([...getProfiles(), profile])
  queueProfileRecord(profile.id, profile)
  return profile
}
export function updateProfile(profileId: string, update: Pick<Partial<AuralesProfile>, 'name' | 'avatar' | 'accent'>): AuralesProfile | null {
  let changed: AuralesProfile | null = null
  writeProfiles(getProfiles().map((profile) => {
    if (profile.id !== profileId) return profile
    changed = { ...profile, ...update, name: update.name?.trim() || profile.name, updatedAt: now() }
    return changed
  }))
  if (changed) queueProfileRecord(profileId, changed)
  return changed
}
export function deleteProfile(profileId: string): boolean {
  const profiles = getProfiles()
  if (profiles.length <= 1 || !profiles.some((profile) => profile.id === profileId)) return false
  writeProfiles(profiles.filter((profile) => profile.id !== profileId))
  queueProfileRecord(profileId, { id: profileId, deleted: true })
  if (getActiveProfileId() === profileId) setActiveProfile(getProfiles()[0].id)
  return true
}

/** Used only by the sync transport after it has authenticated and validated a remote profile record. */
export function applySyncedProfile(profile: AuralesProfile | { id: string; deleted: true }): void {
  const profiles = getProfiles()
  if ('deleted' in profile && profile.deleted) {
    if (profiles.length > 1) writeProfiles(profiles.filter((entry) => entry.id !== profile.id))
    return
  }
  const synced = profile as AuralesProfile
  const existing = profiles.find((entry) => entry.id === profile.id)
  writeProfiles(existing ? profiles.map((entry) => entry.id === profile.id ? { ...entry, ...synced } : entry) : [...profiles, synced])
}
