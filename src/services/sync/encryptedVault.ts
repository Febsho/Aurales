import { enqueueSyncRecord } from './syncQueue'
import { getActiveProfileId, getActiveProfile, getStoredProfileOwnedState, isProfileOwnedStorageKey, isProfileRuntimeLoaded, storeProfileOwnedValues } from '../profiles'

const vaultId = (profileId: string) => `profile-settings-v1:${profileId}`
const ITERATIONS = 600_000
let vaultPassphrase: string | null = null

export interface EncryptedVault {
  formatVersion?: 2
  profileId?: string
  algorithm: 'AES-GCM'
  kdf: 'PBKDF2-SHA-256'
  iterations: number
  salt: string
  iv: string
  ciphertext: string
}

const included = (key: string, profileId: string) => isProfileOwnedStorageKey(key) || key.endsWith(`:profile:${profileId}`)

function bytesToBase64(bytes: Uint8Array): string {
  // Web Crypto ciphertext can contain the full profile settings and quickly
  // exceed the engine's maximum function-argument count. Convert in bounded
  // chunks instead of spreading the entire byte array into fromCharCode.
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}
const base64ToBytes = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
const bufferSource = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
async function vaultKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: bufferSource(salt), iterations: ITERATIONS }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** Keeps the Sync-account password only in memory; it is never written to local or remote storage. */
export function unlockSyncVault(passphrase: string): void {
  if (passphrase.length < 12) throw new Error('Use a Sync account password of at least 12 characters.')
  vaultPassphrase = passphrase
}
export function isSyncVaultUnlocked(): boolean { return Boolean(vaultPassphrase) }
export function lockSyncVault(): void { vaultPassphrase = null }
export function vaultSettingCount(): number { const profileId = getActiveProfileId(); return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter((key): key is string => Boolean(key && included(key, profileId))).length }
function hashText(seed: number, value: string): number {
  let hash = seed
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}
/** A local-only fingerprint used to notice profile-owned setting changes and
 * schedule a sync. It is never sent to the server. */
export function profileSyncFingerprint(profileId = getActiveProfileId()): string {
  let count = 0
  let sum = 0
  let xor = 0
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (!key || !included(key, profileId)) continue
    const value = localStorage.getItem(key) || ''
    const entryHash = hashText(hashText(hashText(2166136261, key), '\u0000'), value)
    count += 1
    sum = (sum + entryHash) >>> 0
    xor ^= Math.imul(entryHash ^ value.length, 0x9e3779b1)
  }
  return `${count}:${sum}:${xor >>> 0}`
}

export async function queueEncryptedVault(profileId = getActiveProfileId()): Promise<number> {
  if (!vaultPassphrase) throw new Error('Unlock the encrypted vault first.')
  const runtimeBelongsToTarget = isProfileRuntimeLoaded(profileId)
  // The persisted snapshot is required even for the active profile: switching
  // profiles first saves its runtime keys to IndexedDB and clears localStorage,
  // while ACTIVE_KEY still names the outgoing profile until the switch commits.
  // Starting from the snapshot also preserves keys whose writer has already
  // moved them out of the shared runtime key space.
  const entries: Record<string, string> = await getStoredProfileOwnedState(profileId)
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (!key) continue
    // Unscoped runtime keys belong to whichever profile is currently loaded.
    // When exporting another profile, use its persisted snapshot and only
    // overlay explicitly profile-scoped settings from localStorage.
    const belongsToTarget = runtimeBelongsToTarget ? included(key, profileId) : key.endsWith(`:profile:${profileId}`)
    if (belongsToTarget) entries[key] = localStorage.getItem(key) || ''
  }
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const additionalData = new TextEncoder().encode(vaultId(profileId))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bufferSource(iv), additionalData: bufferSource(additionalData) }, await vaultKey(vaultPassphrase, salt), new TextEncoder().encode(JSON.stringify(entries)))
  const payload: EncryptedVault = { formatVersion: 2, profileId, algorithm: 'AES-GCM', kdf: 'PBKDF2-SHA-256', iterations: ITERATIONS, salt: bytesToBase64(salt), iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)) }
  enqueueSyncRecord('encrypted-vault', vaultId(profileId), payload, profileId)
  return Object.keys(entries).length
}

/** Applies only a vault encrypted with the passphrase currently in memory. */
export async function restoreEncryptedVault(payload: EncryptedVault, profileId = getActiveProfileId()): Promise<number> {
  if (!vaultPassphrase) throw new Error('Enter the vault passphrase to restore encrypted settings.')
  if (payload.algorithm !== 'AES-GCM' || payload.kdf !== 'PBKDF2-SHA-256' || !payload.salt || !payload.iv || !payload.ciphertext) throw new Error('Unsupported encrypted vault format.')
  if (payload.formatVersion != null && payload.formatVersion !== 2) throw new Error('Unsupported encrypted vault format.')
  if (payload.formatVersion === 2 && payload.profileId !== profileId) throw new Error('This encrypted vault belongs to a different profile.')
  const key = await vaultKey(vaultPassphrase, base64ToBytes(payload.salt))
  const additionalData = payload.formatVersion === 2 ? bufferSource(new TextEncoder().encode(vaultId(profileId))) : undefined
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bufferSource(base64ToBytes(payload.iv)), ...(additionalData ? { additionalData } : {}) }, key, bufferSource(base64ToBytes(payload.ciphertext)))
  const entries = JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Invalid encrypted vault contents.')
  const restoredEntries: Record<string, string> = {}
  for (const [name, value] of Object.entries(entries)) {
    if (included(name, profileId) && typeof value === 'string') restoredEntries[name] = value
  }
  if (profileId === getActiveProfile().id) {
    for (const [name, value] of Object.entries(restoredEntries)) localStorage.setItem(name, value)
  } else {
    await storeProfileOwnedValues(profileId, restoredEntries)
  }
  return Object.keys(restoredEntries).length
}
