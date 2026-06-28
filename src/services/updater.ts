import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

export interface UpdateInfo {
  version: string
  date?: string
  body?: string
}

export interface UpdateProgress {
  downloaded: number
  total: number | null
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

  let downloaded = 0
  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      const total = event.data.contentLength ?? null
      onProgress?.({ downloaded: 0, total })
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength
      onProgress?.({ downloaded, total: null })
    } else if (event.event === 'Finished') {
      onProgress?.({ downloaded, total: downloaded })
    }
  })

  await relaunch()
}

export function getAppVersion(): string {
  return __APP_VERSION__
}

declare const __APP_VERSION__: string
