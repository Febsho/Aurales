import { invoke } from '@tauri-apps/api/core'

export interface DiscordActivity {
  details?: string
  state?: string
  largeImage?: string
  largeText?: string
  smallImage?: string
  smallText?: string
  startTimestamp?: number
  endTimestamp?: number
  activityType?: number // 0=Playing, 3=Watching
}

const defaultBrowsingActivity: DiscordActivity = {
  details: 'Browsing',
  largeImage: 'aurales_logo',
  largeText: 'Aurales',
  activityType: 3,
}

let browsingActivity: DiscordActivity = defaultBrowsingActivity

export async function setDiscordActivity(activity: DiscordActivity): Promise<void> {
  await invoke('discord_set_activity', {
    details: activity.details,
    state: activity.state,
    largeImage: activity.largeImage,
    largeText: activity.largeText,
    smallImage: activity.smallImage,
    smallText: activity.smallText,
    startTimestamp: activity.startTimestamp,
    endTimestamp: activity.endTimestamp,
    activityType: activity.activityType,
  })
}

export async function setDiscordBrowsingActivity(activity?: DiscordActivity): Promise<void> {
  browsingActivity = activity || defaultBrowsingActivity
  await setDiscordActivity(browsingActivity)
}

export async function restoreDiscordBrowsingActivity(): Promise<void> {
  await setDiscordActivity(browsingActivity)
}

export async function clearDiscordActivity(): Promise<void> {
  await invoke('discord_clear_activity')
}

export async function disconnectDiscord(): Promise<void> {
  await invoke('discord_disconnect')
}
