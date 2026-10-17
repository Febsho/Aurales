import { v4 as uuid } from 'uuid'
import type { ProfileAvatarRef } from '../data/profileAvatars'
import { enqueueSyncRecord, scheduleAutomaticSync } from './sync/syncQueue'

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
const PENDING_DELETIONS_KEY = 'aurales_sync_profile_deletions_v1'
export const PROFILE_CHANGED_EVENT = 'aurales:profile-changed'
export const PROFILE_SWITCH_TRANSITION_KEY = 'aurales_profile_switch_transition_v1'
// ACTIVE_KEY changes only after the incoming profile has been loaded. Track
// the owner of the shared runtime keys separately so background sync cannot
// snapshot an incoming profile under the outgoing profile ID during that gap.
let runtimeProfileId: string | null | undefined

// User-owned legacy keys which are safely copied to the initial profile.  Keep
// credentials and addon configuration global; those must never be silently
// duplicated or migrated between people.
const MIGRATED_KEYS = [
  'aurales_watch_progress', 'aurales_recently_viewed',
  'aurales_preferred_subtitles', 'aurales_preferred_audio', 'aurales_subtitle_mode',
  'aurales_prefer_sdh_subtitles', 'aurales_anime_audio_mode',
  'aurales_local_watchlist_v1', 'aurales_discovery_feedback_v1',
  'aurales_stream_reliability_v1', 'aurales_stream_playback_memory_v1',
  'aurales_home_rows', 'aurales_discovery_starter_genres', 'aurales_discovery_mode',
  'aurales_upcoming_preferences_v1', 'aurales_continue_watching_suppressions_v1', 'aurales_skip_profile_picker',
  'aurales_poster_size', 'aurales_home_hero_mode', 'aurales_home_card_animations',
  'aurales_fixed_hero_source', 'aurales_fixed_hero_manual_item', 'aurales_hero_trailer_delay',
  'aurales_poster_trailer_previews', 'aurales_poster_trailer_hover_delay_ms',
  'aurales_poster_trailer_sound', 'aurales_trailer_volume',
  'aurales_video_cache_mode',
]
/** Profile-owned preferences included in portable settings backups. */
export const PROFILE_BACKUP_KEYS = MIGRATED_KEYS
const PROFILE_OWNED_CACHE_SETTING_KEYS = new Set(['aurales_video_cache_mode'])

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
    && (!key.includes('cache') || PROFILE_OWNED_CACHE_SETTING_KEYS.has(key))
    && !key.includes('snapshot')
}
/** Returns only the active profile's app-owned settings and account data. */
export function getProfileBackupEntries(profileId = getActiveProfileId()): Record<string, string> {
  const entries: Record<string, string> = {}
  const suffix = `:profile:${profileId}`
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (!key) continue
    const scopedBase = key.endsWith(suffix) ? key.slice(0, -suffix.length) : ''
    if (isProfileOwnedStorageKey(key) || (scopedBase && isProfileOwnedStorageKey(scopedBase))) {
      const value = localStorage.getItem(key)
      if (value !== null) entries[key] = value
    }
  }
  return entries
}
export function isProfileBackupStorageKey(key: string): boolean {
  if (isProfileOwnedStorageKey(key)) return true
  const marker = key.lastIndexOf(':profile:')
  if (marker <= 0) return false
  const scopedProfileId = key.slice(marker + ':profile:'.length)
  return Boolean(scopedProfileId && !scopedProfileId.includes(':') && isProfileOwnedStorageKey(key.slice(0, marker)))
}
export function profileBackupStorageKeyForImport(key: string, profileId = getActiveProfileId()): string | null {
  if (!isProfileBackupStorageKey(key)) return null
  const marker = key.lastIndexOf(':profile:')
  if (marker <= 0) return key
  return profileStorageKey(key.slice(0, marker), profileId)
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
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(PROFILE_STATE_STORE, 'readonly')
    const request = transaction.objectStore(PROFILE_STATE_STORE).get(profileId)
    let settled = false
    const finish = (error?: DOMException | null) => {
      if (settled) return
      settled = true
      db.close()
      if (error) reject(error)
      else resolve(request.result as Record<string, string> | undefined)
    }
    request.onsuccess = () => finish()
    request.onerror = () => finish(request.error || new DOMException('Profile state read failed', 'UnknownError'))
    transaction.onabort = () => finish(transaction.error || new DOMException('Profile state read was aborted', 'AbortError'))
  })
}
async function writeStoredProfileState(profileId: string, entries: Record<string, string>): Promise<void> {
  const db = await openProfileStateDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(PROFILE_STATE_STORE, 'readwrite')
    let settled = false
    const finish = (error?: DOMException | null) => {
      if (settled) return
      settled = true
      db.close()
      if (error) reject(error)
      else resolve()
    }
    transaction.oncomplete = () => finish()
    transaction.onerror = () => finish(transaction.error || new DOMException('Profile state transaction failed', 'UnknownError'))
    transaction.onabort = () => finish(transaction.error || new DOMException('Profile state transaction was aborted', 'AbortError'))
    try { transaction.objectStore(PROFILE_STATE_STORE).put(entries, profileId) }
    catch (error) {
      try { transaction.abort() } catch { /* already inactive */ }
      finish(error instanceof DOMException ? error : new DOMException(String(error), 'UnknownError'))
    }
  })
}
async function deleteStoredProfileState(profileId: string): Promise<void> {
  const db = await openProfileStateDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(PROFILE_STATE_STORE, 'readwrite')
    let settled = false
    const finish = (error?: DOMException | null) => {
      if (settled) return
      settled = true
      db.close()
      if (error) reject(error)
      else resolve()
    }
    transaction.oncomplete = () => finish()
    transaction.onerror = () => finish(transaction.error || new DOMException('Profile state deletion failed', 'UnknownError'))
    transaction.onabort = () => finish(transaction.error || new DOMException('Profile state deletion was aborted', 'AbortError'))
    try { transaction.objectStore(PROFILE_STATE_STORE).delete(profileId) }
    catch (error) {
      try { transaction.abort() } catch { /* already inactive */ }
      finish(error instanceof DOMException ? error : new DOMException(String(error), 'UnknownError'))
    }
  })
}
function readLegacyProfileState(profileId: string): Record<string, string> {
  const prefix = `${PROFILE_STATE_PREFIX}${profileId}:`; const entries: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i += 1) { const key = localStorage.key(i); if (key?.startsWith(prefix)) entries[key.slice(prefix.length)] = localStorage.getItem(key) || '' }
  return entries
}
async function saveProfileState(profileId: string): Promise<void> {
  let entries = collectProfileState()
  // Profile-owned writes can still arrive while IndexedDB commits the first
  // snapshot (for example, a playback checkpoint). Re-capture until the
  // runtime is stable; otherwise removing its keys after the await can erase
  // writes that were never included in the committed state.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    // Commit first. The active runtime is untouched until IndexedDB confirms
    // the full snapshot, preventing a quota failure from erasing a profile.
    await writeStoredProfileState(profileId, entries)
    const latest = collectProfileState()
    const keys = Object.keys(entries)
    if (keys.length === Object.keys(latest).length && keys.every((key) => latest[key] === entries[key])) {
      // This check and removal are synchronous, so no writer can interleave.
      keys.forEach((key) => {
        if (localStorage.getItem(key) === entries[key]) localStorage.removeItem(key)
      })
      return
    }
    entries = latest
  }
  // Leave runtime keys intact and abort switching if state keeps changing.
  // Losing the current session's last writes is worse than asking the user to
  // stop playback and switch again.
  throw new Error('Profile state kept changing while it was being saved')
}
function clearRuntimeProfileState(): void {
  const stale: string[] = []
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (key && isProfileOwnedStorageKey(key)) stale.push(key)
  }
  stale.forEach((key) => localStorage.removeItem(key))
  runtimeProfileId = null
}
async function loadProfileState(profileId: string): Promise<void> {
  const stored = await readStoredProfileState(profileId)
  const candidate = stored ?? readLegacyProfileState(profileId)
  // Only restore the same string-valued runtime keys that profile capture
  // permits. This also makes old or damaged IndexedDB snapshots unable to
  // overwrite global profile/sync metadata or create arbitrary localStorage
  // keys during a profile switch.
  const entries = Object.fromEntries(Object.entries(candidate).filter(([key, value]) =>
    isProfileOwnedStorageKey(key) && typeof value === 'string',
  ))
  clearRuntimeProfileState()
  Object.entries(entries).forEach(([key, value]) => localStorage.setItem(key, value))
  runtimeProfileId = profileId
}
export function isProfileRuntimeLoaded(profileId: string): boolean {
  // Before the first explicit profile load, the app starts with the persisted
  // active profile already in localStorage. During transitions, null prevents
  // ACTIVE_KEY from being mistaken for ownership of cleared/incoming values.
  return runtimeProfileId === undefined
    ? profileId === getActiveProfileId()
    : runtimeProfileId === profileId
}
export async function storeProfileOwnedValue(profileId: string, key: string, value: string): Promise<void> {
  await storeProfileOwnedValues(profileId, { [key]: value })
}
export async function storeProfileOwnedValues(profileId: string, values: Record<string, string>): Promise<void> {
  const legacy = readLegacyProfileState(profileId)
  const db = await openProfileStateDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(PROFILE_STATE_STORE, 'readwrite')
    const store = transaction.objectStore(PROFILE_STATE_STORE)
    const request = store.get(profileId)
    request.onsuccess = () => {
      const stored = request.result
      const state = stored && typeof stored === 'object' && !Array.isArray(stored)
        ? stored as Record<string, string>
        : legacy
      store.put({ ...state, ...values }, profileId)
    }
    request.onerror = () => transaction.abort()
    transaction.oncomplete = () => { db.close(); resolve() }
    transaction.onerror = () => { db.close(); reject(transaction.error || request.error) }
    transaction.onabort = () => { db.close(); reject(transaction.error || request.error || new Error('Could not update profile state')) }
  })
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
export function getPendingProfileDeletions(): Array<{ id: string; deletedAt: string }> {
  try { const value = JSON.parse(localStorage.getItem(PENDING_DELETIONS_KEY) || '[]'); return Array.isArray(value) ? value.filter((item): item is { id: string; deletedAt: string } => Boolean(item?.id && item?.deletedAt)) : [] } catch { return [] }
}
export function clearPendingProfileDeletions(
  uploaded?: readonly { id: string; deletedAt: string }[],
): void {
  if (!uploaded) {
    localStorage.removeItem(PENDING_DELETIONS_KEY)
    return
  }
  const acknowledged = new Set(uploaded.map(({ id, deletedAt }) => `${id}\u0000${deletedAt}`))
  const remaining = getPendingProfileDeletions().filter((deletion) =>
    !acknowledged.has(`${deletion.id}\u0000${deletion.deletedAt}`),
  )
  if (remaining.length) localStorage.setItem(PENDING_DELETIONS_KEY, JSON.stringify(remaining))
  else localStorage.removeItem(PENDING_DELETIONS_KEY)
}
function queueProfileRecord(profileId: string, payload: AuralesProfile | { id: string; deleted: true }): void {
  // Queueing sync remains best-effort and must never block local profile edits.
  try { enqueueSyncRecord('profile', profileId, payload, profileId) }
  catch (error) { console.warn('[profiles] could not queue profile sync', error) }
}

export function profileStorageKey(key: string, profileId = getActiveProfileId()): string {
  return `${key}:profile:${profileId}`
}
/** Cache identifiers for data fetched using profile-specific provider accounts. */
export function profileProviderCacheKey(
  key: string,
  provider: 'trakt' | 'simkl' | 'pmdb' | 'mdblist' | 'anilist',
  profileId = getActiveProfileId(),
): string {
  const accountKeys: Record<typeof provider, [string, string]> = {
    trakt: ['trakt_account', 'username'],
    simkl: ['simkl_account', 'id'],
    anilist: ['anilist_account', 'id'],
    pmdb: ['aurales_cw_credential_scope:pmdb', ''],
    mdblist: ['aurales_cw_credential_scope:mdblist', ''],
  }
  const [storageKey, field] = accountKeys[provider]
  let accountScope = localStorage.getItem(storageKey) || 'anonymous'
  if (field && accountScope !== 'anonymous') {
    try { accountScope = String((JSON.parse(accountScope) as Record<string, unknown>)?.[field] || 'anonymous') }
    catch { accountScope = 'anonymous' }
  }
  return `${key}:profile:${profileId}:account:${encodeURIComponent(accountScope)}`
}
export function getProfileSetting(key: string, profileId = getActiveProfileId()): string | null {
  const scopedKey = profileStorageKey(key, profileId)
  const scoped = localStorage.getItem(scopedKey)
  if (scoped != null) return scoped
  const legacy = localStorage.getItem(key)
  if (legacy == null) return null
  // Older releases stored some settings globally. Move the value to the
  // profile that first reads it, then remove the fallback so a second profile
  // cannot silently inherit the first profile's preferences.
  try {
    localStorage.setItem(scopedKey, legacy)
    localStorage.removeItem(key)
  } catch (error) {
    console.warn(`[profiles] could not migrate setting ${key}`, error)
  }
  return legacy
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
let profileSwitchPending: Promise<boolean> | null = null
let pendingProfileId: string | null = null
export function setActiveProfile(profileId: string): Promise<boolean> {
  if (!getProfiles().some((profile) => profile.id === profileId)) return Promise.resolve(false)
  // Profile switching snapshots and replaces shared runtime keys. Serialize
  // the transition, but retain the latest selection so a second click during
  // IndexedDB/vault work is not silently discarded.
  pendingProfileId = profileId
  if (profileSwitchPending) return profileSwitchPending
  profileSwitchPending = performProfileSwitch(profileId).finally(() => {
    pendingProfileId = null
    profileSwitchPending = null
  })
  return profileSwitchPending
}

async function performProfileSwitch(profileId: string): Promise<boolean> {
  if (!getProfiles().some((profile) => profile.id === profileId)) return false
  const previous = getActiveProfileId()
  if (previous === profileId) return true
  // Let services with short write-behind buffers persist into the outgoing
  // profile before its shared runtime keys are captured and replaced.
  const flushers: Array<() => boolean> = []
  window.dispatchEvent(new CustomEvent('aurales:flush-pending-profile-state', { detail: { flushers } }))
  if (flushers.some((flush) => !flush())) return false
  // Persist the old session first, but never leave the profile switch button
  // inert if a browser storage write fails (for example after a cache-heavy
  // session fills a WebView quota). The selected profile can still open.
  try { await saveProfileState(previous) } catch (error) { console.error('[profiles] could not save outgoing profile state', error); return false }
  // The outgoing snapshot has already moved from localStorage into IndexedDB,
  // so finish its encrypted backup before loading another profile into the
  // shared runtime key space. Otherwise the asynchronous vault builder could
  // read the incoming profile while ACTIVE_KEY still names the outgoing one.
  await import('./sync/encryptedVault')
    .then(({ queueEncryptedVault }) => queueEncryptedVault(previous))
    .then(async () => {
      const { flushOutbox } = await import('./sync/outbox')
      await flushOutbox()
    })
    .catch(() => {})
  let selectedProfileId = profileId
  try {
    // A later picker click can arrive while IndexedDB is loading the first
    // selection. Reload the newest target before exposing it as active.
    do {
      selectedProfileId = pendingProfileId || selectedProfileId
      await loadProfileState(selectedProfileId)
    } while (pendingProfileId !== selectedProfileId)
  } catch (error) {
    try { await loadProfileState(previous) } catch (restoreError) {
      console.error('[profiles] could not restore outgoing profile state after failed switch', restoreError)
    }
    console.error('[profiles] could not load selected profile state', error)
    return false
  }
  // A later click can cancel the transition by selecting the profile that was
  // active when it began. Its snapshot has just been restored, so no reload is
  // needed in that case.
  if (selectedProfileId === previous) return true
  if (!getProfiles().some((profile) => profile.id === selectedProfileId)) {
    try { await loadProfileState(previous) } catch (restoreError) {
      console.error('[profiles] could not restore outgoing profile state after target deletion', restoreError)
    }
    return false
  }
  try { localStorage.setItem(ACTIVE_KEY, selectedProfileId) } catch (error) {
    try { await loadProfileState(previous) } catch (restoreError) {
      console.error('[profiles] could not restore outgoing profile state after failed activation', restoreError)
    }
    console.error('[profiles] could not activate profile', error)
    return false
  }
  window.dispatchEvent(new CustomEvent(PROFILE_CHANGED_EVENT, { detail: { profileId: selectedProfileId } }))
  try { scheduleAutomaticSync(250) } catch { /* Profile switching is local-first. */ }
  // Many provider integrations read their tokens only on module/store setup.
  // A reload makes the newly selected profile a clean, isolated app session.
  // Skip the startup chooser after an intentional in-app switch. Without this
  // marker the reload immediately opens the same chooser again and makes the
  // switch appear to have done nothing.
  try {
    sessionStorage.setItem('aurales_profile_switched_v1', selectedProfileId)
    const nextProfile = getProfiles().find((profile) => profile.id === selectedProfileId)
    if (nextProfile) sessionStorage.setItem(PROFILE_SWITCH_TRANSITION_KEY, JSON.stringify(nextProfile))
  } catch (error) {
    // These markers only skip the startup picker and provide a transition
    // animation. Their absence must not strand a successfully activated
    // profile in a runtime that still reflects the previous app session.
    console.warn('[profiles] could not save profile switch transition markers', error)
  }
  // A profile is a separate Aurales user space. Always begin its fresh session
  // at Home rather than leaving it on a detail/settings screen from another
  // profile.
  window.location.assign('/')
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
export async function deleteProfile(profileId: string): Promise<boolean> {
  const profiles = getProfiles()
  if (profiles.length <= 1 || !profiles.some((profile) => profile.id === profileId)) return false
  const wasActive = getActiveProfileId() === profileId
  const nextProfiles = profiles.filter((profile) => profile.id !== profileId)
  const previousDeletionState = localStorage.getItem(PENDING_DELETIONS_KEY)
  const nextDeletions = [...getPendingProfileDeletions().filter((item) => item.id !== profileId), { id: profileId, deletedAt: now() }]
  // Deleting a profile on one device must not destroy the only cloud copy.
  // A later Pull is intentionally able to bring it back (including its
  // settings and connected accounts). Cloud-wide deletion needs a separate,
  // explicit destructive action rather than an incidental local deletion.
  // The pending marker is sent only by the manual Push action.
  // Persist both pieces of deletion metadata before removing any profile
  // state. If localStorage is full, roll back the marker and leave the profile
  // available instead of hiding it while its keys still belong to the runtime.
  try {
    localStorage.setItem(PENDING_DELETIONS_KEY, JSON.stringify(nextDeletions))
    writeProfiles(nextProfiles)
  } catch (error) {
    try {
      if (previousDeletionState == null) localStorage.removeItem(PENDING_DELETIONS_KEY)
      else localStorage.setItem(PENDING_DELETIONS_KEY, previousDeletionState)
    } catch (rollbackError) {
      console.error('[profiles] could not roll back a failed profile deletion marker', rollbackError)
    }
    throw error
  }
  const scopedSuffix = `:profile:${profileId}`
  const scopedKeys: string[] = []
  const legacyPrefix = `${PROFILE_STATE_PREFIX}${profileId}:`
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (key && (key.endsWith(scopedSuffix) || key.startsWith(legacyPrefix))) scopedKeys.push(key)
  }
  scopedKeys.forEach((key) => localStorage.removeItem(key))
  const deleteStoredState = deleteStoredProfileState(profileId).catch((error) => {
    console.error('[profiles] could not remove deleted profile state', error)
  })
  if (wasActive) {
    const nextProfileId = getProfiles()[0].id
    // The active profile no longer exists, so clear its runtime keys before
    // awaiting IndexedDB. If the read fails, a reload must never interpret the
    // deleted profile's settings as belonging to the replacement profile.
    clearRuntimeProfileState()
    localStorage.setItem(ACTIVE_KEY, nextProfileId)
    const loadNextProfile = loadProfileState(nextProfileId).catch((error) => {
      // The active ID already points at the replacement profile and runtime
      // keys were cleared. Reload even on a failed IndexedDB read so in-memory
      // Zustand state from the deleted profile cannot remain on screen.
      console.error('[profiles] could not load replacement profile after local deletion', error)
    })
    await Promise.all([loadNextProfile, deleteStoredState])
    window.location.reload()
    return true
  }
  await deleteStoredState
  return true
}

/** Used only by the sync transport after it has authenticated and validated a remote profile record. */
export function applySyncedProfile(profile: AuralesProfile | { id: string; deleted: true }): void {
  const profiles = getProfiles()
  if ('deleted' in profile && profile.deleted) {
    // A local device must always retain one usable profile. If a remote
    // tombstone targets that sole profile, preserve its state as well; keeping
    // the profile record while erasing its settings would strand the account
    // with an empty profile after the cursor advances past this tombstone.
    if (profiles.length === 1 && profiles[0].id === profile.id) return
    const wasActive = getActiveProfileId() === profile.id
    const remaining = profiles.filter((entry) => entry.id !== profile.id)
    if (profiles.length > 1 && remaining.length) writeProfiles(remaining)
    const suffix = `:profile:${profile.id}`
    const legacyPrefix = `${PROFILE_STATE_PREFIX}${profile.id}:`
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index)
      if (key && (key.endsWith(suffix) || key.startsWith(legacyPrefix))) localStorage.removeItem(key)
    }
    void deleteStoredProfileState(profile.id).catch((error) => {
      console.error('[profiles] could not remove remotely deleted profile state', error)
    })
    if (wasActive && remaining.length) {
      const nextProfileId = remaining[0].id
      // Do not let the following profile-changed event hydrate deleted
      // profile data under the replacement profile while IndexedDB is loading.
      clearRuntimeProfileState()
      try { localStorage.setItem(ACTIVE_KEY, nextProfileId) }
      catch (error) { console.error('[profiles] could not activate replacement profile', error); return }
      void loadProfileState(nextProfileId).catch((error) => {
        console.error('[profiles] could not load replacement profile after remote deletion', error)
      }).finally(() => {
        // Keep the running store isolated from the deleted profile even when
        // the replacement snapshot could not be read from IndexedDB.
        window.location.reload()
      })
    }
    return
  }
  const synced = profile as AuralesProfile
  const existing = profiles.find((entry) => entry.id === profile.id)
  writeProfiles(existing ? profiles.map((entry) => entry.id === profile.id ? { ...entry, ...synced } : entry) : [...profiles, synced])
}
