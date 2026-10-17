import catalog from './netflix-retired.json'

export type ProfileAvatarSource = 'netflix-retired'
export interface ProfileAvatarRef { source: ProfileAvatarSource; avatarId: string }
export interface ProfileAvatar { id: string; name: string; category: string; show: string; showId: string; imageUrl: string; source: ProfileAvatarSource }

export const profileAvatars = catalog.avatars as ProfileAvatar[]
const byId = new Map(profileAvatars.map((avatar) => [avatar.id, avatar]))
export const profileAvatarShows = [...new Set(profileAvatars.map((avatar) => avatar.show))]

export function getProfileAvatar(ref?: ProfileAvatarRef): ProfileAvatar | undefined {
  return ref?.source === 'netflix-retired' ? byId.get(ref.avatarId) : undefined
}
export function searchProfileAvatars(query = '', show = ''): ProfileAvatar[] {
  const normalized = query.trim().toLocaleLowerCase()
  return profileAvatars.filter((avatar) => (!show || avatar.show === show) && (!normalized || `${avatar.name} ${avatar.show} ${avatar.category}`.toLocaleLowerCase().includes(normalized)))
}
