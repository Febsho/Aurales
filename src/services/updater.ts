import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export interface UpdateInfo {
  version: string
  date?: string
  body?: string
}

export interface UpdateProgress {
  downloaded: number
  total: number | null
  stage?: 'downloading' | 'installing'
}

const RELEASE_BASE_URL = 'https://github.com/Febsho/Aurales/releases'

/**
 * CI currently publishes a standalone Flatpak bundle, not an OSTree
 * repository. Installing that bundle creates a disabled `app-origin`, so
 * `flatpak update com.aurales.app` can never discover a newer release.
 */
export function getFlatpakInstallCommand(version: string): string {
  return `flatpak install --reinstall ~/Downloads/Aurales_${version}_amd64.flatpak`
}

export async function openFlatpakRelease(version: string): Promise<void> {
  await invoke('open_simkl_auth', { url: `${RELEASE_BASE_URL}/tag/v${encodeURIComponent(version)}` })
}

let installKind: Promise<string> | null = null

function getInstallKind(): Promise<string> {
  installKind ??= invoke<string>('install_kind').catch(() => 'self-updating')
  return installKind
}

/**
 * Both supported Linux packages can update in-app. AppImage uses Tauri's
 * signed updater; standalone Flatpak bundles use the native host installer.
 */
export async function canSelfUpdate(): Promise<boolean> {
  await getInstallKind()
  return true
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const update = await check()
    if (!update) return null
    return {
      version: update.version,
      date: update.date ?? undefined,
      body: update.body ?? undefined,
    }
  } catch (e) {
    console.error('[Updater] Check failed:', e)
    throw e
  }
}

export async function downloadAndInstall(
  onProgress?: (progress: UpdateProgress) => void
): Promise<void> {
  const update = await check()
  if (!update) throw new Error('No update available')

  if ((await getInstallKind()) === 'flatpak') {
    const unlisten = await listen<{
      downloaded: number
      total: number | null
      stage: 'downloading' | 'installing'
    }>('flatpak-update-progress', ({ payload }) => {
      onProgress?.({ downloaded: payload.downloaded, total: payload.total, stage: payload.stage })
    })
    try {
      await invoke('install_flatpak_update', { version: update.version })
    } finally {
      unlisten()
    }
    return
  }

  let downloaded = 0
  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      const total = event.data.contentLength ?? null
      onProgress?.({ downloaded: 0, total, stage: 'downloading' })
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength
      onProgress?.({ downloaded, total: null, stage: 'downloading' })
    } else if (event.event === 'Finished') {
      onProgress?.({ downloaded, total: downloaded, stage: 'installing' })
    }
  })

  await relaunch()
}

export interface ReleaseNotes {
  tag: string
  title?: string
  body: string
  publishedAt?: string
}

/** Patch notes from the latest GitHub release; null when unavailable. */
export async function getLatestReleaseNotes(): Promise<ReleaseNotes | null> {
  try {
    const raw = await invoke<string>('github_release_notes')
    const data = JSON.parse(raw) as { tag_name?: string; name?: string; body?: string; published_at?: string }
    if (!data.tag_name && !data.body) return null
    return {
      tag: data.tag_name || '',
      title: data.name || undefined,
      body: data.body || '',
      publishedAt: data.published_at || undefined,
    }
  } catch (e) {
    console.warn('[Updater] Release notes fetch failed:', e)
    return null
  }
}

export function getAppVersion(): string {
  return __APP_VERSION__
}

declare const __APP_VERSION__: string
