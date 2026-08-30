import { v4 as uuid } from 'uuid'
import type { ProfileAvatarRef } from '../data/profileAvatars'

export interface AuralesProfile {
  id: string
  name: string
  avatar?: string
  avatarRef?: ProfileAvatarRef
  accent?: string
  createdAt: string
  updatedAt: string
  isDefault?: boolean
}

const PROFILES_KEY = 'aurales_profiles_v1'
const ACTIVE_KEY = 'aurales_active_profile_v1'
const PROFILE_STATE_PREFIX = 'aurales_profile_state_v1:'
const PROFILE_STATE_DB = 'aurales-profile-state-v1'
const PROFILE_STATE_STORE = 'states'
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
  'aurales_poster_size', 'aurales_home_hero_mode', 'aurales_home_card_animations',
  'aurales_fixed_hero_source', 'aurales_fixed_hero_manual_item', 'aurales_hero_trailer_delay',
  'aurales_poster_trailer_previews', 'aurales_poster_trailer_hover_delay_ms',
  'aurales_poster_trailer_sound', 'aurales_trailer_volume',
]

function now() { return new Date().toISOString() }
function stateKey(profileId: string, key: string): string { return `${PROFILE_STATE_PREFIX}${profileId}:${key}` }
/** Sync transport/device identity stays on this installation. Everything else,
 * including provider sessions and user settings, belongs to the active profile. */
export function isProfileOwnedStorageKey(key: string): boolean {
  return !key.startsWith('aurales_sync_')
    && key !== PROFILES_KEY && key !== ACTIVE_KEY
    && key !== 'aurales_sync_device_v1'
    && !key.startsWith(PROFILE_STATE_PREFIX)
    && !key.includes(':profile:')
    && !key.includes('cache') && !key.includes('snapshot')
}
export function profileStateStorageKey(profileId: string, key: string): string { return stateKey(profileId, key) }
/** Capture the active profile's ordinary localStorage state, then restore a
 * different profile into the same runtime key space. This lets legacy provider
 * clients continue reading their normal keys while keeping each login private. */
function collectProfileState(): Record<string, string> {
  const entries: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i += 1) { const key = localStorage.key(i); if (key && isProfileOwnedStorageKey(key)) entries[key] = localStorage.getItem(key) || '' }
  return entries
}
function openProfileStateDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PROFILE_STATE_DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(PROFILE_STATE_STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open profile state storage'))
  })
}
async function readStoredProfileState(profileId: string): Promise<Record<string, string> | undefined> {
  const db = await openProfileStateDb()
  return new Promise((resolve, reject) => { const request = db.transaction(PROFILE_STATE_STORE, 'readonly').objectStore(PROFILE_STATE_STORE).get(profileId); request.onsuccess = () => { db.close(); resolve(request.result as Record<string, string> | undefined) }; request.onerror = () => { db.close(); reject(request.error) } })
}
async function writeStoredProfileState(profileId: string, entries: Record<string, string>): Promise<void> {
  const db = await openProfileStateDb()
  await new Promise<void>((resolve, reject) => { const transaction = db.transaction(PROFILE_STATE_STORE, 'readwrite'); transaction.objectStore(PROFILE_STATE_STORE).put(entries, profileId); transaction.oncomplete = () => { db.close(); resolve() }; transaction.onerror = () => { db.close(); reject(transaction.error) } })
}
function readLegacyProfileState(profileId: string): Record<string, string> {
  const prefix = `${PROFILE_STATE_PREFIX}${profileId}:`; const entries: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i += 1) { const key = localStorage.key(i); if (key?.startsWith(prefix)) entries[key.slice(prefix.length)] = localStorage.getItem(key) || '' }
  return entries
}
async function saveProfileState(profileId: string): Promise<void> {
  const entries = collectProfileState()
  // Commit first. The active runtime is untouched until IndexedDB confirms the
  // full snapshot, preventing a quota failure from erasing a profile.
  await writeStoredProfileState(profileId, entries)
  Object.keys(entries).forEach((key) => localStorage.removeItem(key))
}
async function loadProfileState(profileId: string): Promise<void> {
  const stored = await readStoredProfileState(profileId)
  const entries = stored ?? readLegacyProfileState(profileId)
  const stale: string[] = []
  for (let i = 0; i < localStorage.length; i += 1) { const key = localStorage.key(i); if (key && isProfileOwnedStorageKey(key)) stale.push(key) }
  stale.forEach((key) => localStorage.removeItem(key))
  Object.entries(entries).forEach(([key, value]) => localStorage.setItem(key, value))
}
export async function storeProfileOwnedValue(profileId: string, key: string, value: string): Promise<void> {
  const state = (await readStoredProfileState(profileId)) ?? readLegacyProfileState(profileId)
  await writeStoredProfileState(profileId, { ...state, [key]: value })
}
export async function getStoredProfileOwnedState(profileId: string): Promise<Record<string, string>> {
  return (await readStoredProfileState(profileId)) ?? readLegacyProfileState(profileId)
}
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
export function getProfileSetting(key: string, profileId = getActiveProfileId()): string | null {
  return localStorage.getItem(profileStorageKey(key, profileId)) ?? localStorage.getItem(key)
}
export function setProfileSetting(key: string, value: string, profileId = getActiveProfileId()): void {
  localStorage.setItem(profileStorageKey(key, profileId), value)
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
export async function setActiveProfile(profileId: string): Promise<boolean> {
  if (!getProfiles().some((profile) => profile.id === profileId)) return false
  const previous = getActiveProfileId()
  if (previous === profileId) return true
  // Persist the old session first, but never leave the profile switch button
  // inert if a browser storage write fails (for example after a cache-heavy
  // session fills a WebView quota). The selected profile can still open.
  try { await saveProfileState(previous) } catch (error) { console.error('[profiles] could not save outgoing profile state', error); return false }
  void import('./sync/encryptedVault').then(({ queueEncryptedVault }) => queueEncryptedVault(previous)).then(() => import('./sync/auralesSync')).then(({ scheduleAutomaticSync }) => scheduleAutomaticSync(250)).catch(() => {})
  try { localStorage.setItem(ACTIVE_KEY, profileId) } catch (error) { console.error('[profiles] could not activate profile', error); return false }
  try { await loadProfileState(profileId) } catch (error) { localStorage.setItem(ACTIVE_KEY, previous); console.error('[profiles] could not load selected profile state', error); return false }
  window.dispatchEvent(new CustomEvent(PROFILE_CHANGED_EVENT, { detail: { profileId } }))
  // Many provider integrations read their tokens only on module/store setup.
  // A reload makes the newly selected profile a clean, isolated app session.
  // Skip the startup chooser after an intentional in-app switch. Without this
  // marker the reload immediately opens the same chooser again and makes the
  // switch appear to have done nothing.
  sessionStorage.setItem('aurales_profile_switched_v1', profileId)
  window.location.reload()
  return true
}
export function createProfile(name: string, avatar?: string, accent?: string, avatarRef?: ProfileAvatarRef): AuralesProfile {
  const profile: AuralesProfile = { id: uuid(), name: name.trim().slice(0, 40) || 'Profile', avatar, avatarRef, accent, createdAt: now(), updatedAt: now() }
  writeProfiles([...getProfiles(), profile])
  queueProfileRecord(profile.id, profile)
  return profile
}
export function updateProfile(profileId: string, update: Pick<Partial<AuralesProfile>, 'name' | 'avatar' | 'avatarRef' | 'accent'>): AuralesProfile | null {
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
  if (getActiveProfileId() === profileId) void setActiveProfile(getProfiles()[0].id)
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
