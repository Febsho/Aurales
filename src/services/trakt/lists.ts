import { traktFetch } from './auth'

export interface TraktList {
  name: string
  description: string
  privacy: string
  displayNumbers: boolean
  allowComments: boolean
  sortBy: string
  sortHow: string
  createdAt: string
  updatedAt: string
  itemCount: number
  commentCount: number
  likes: number
  ids: { trakt: number; slug: string }
}

export async function getUserLists(): Promise<TraktList[]> {
  const data = await traktFetch('/users/me/lists') as Record<string, unknown>[]
  return data.map((l) => ({
    name: l.name as string,
    description: l.description as string,
    privacy: l.privacy as string,
    displayNumbers: l.display_numbers as boolean,
    allowComments: l.allow_comments as boolean,
    sortBy: l.sort_by as string,
    sortHow: l.sort_how as string,
    createdAt: l.created_at as string,
    updatedAt: l.updated_at as string,
    itemCount: l.item_count as number,
    commentCount: l.comment_count as number,
    likes: l.likes as number,
    ids: l.ids as { trakt: number; slug: string },
  }))
}

export async function getListItems(listId: string): Promise<unknown[]> {
  return await traktFetch(`/users/me/lists/${listId}/items`) as unknown[]
}

export async function addToWatchlist(items: { movies?: unknown[]; shows?: unknown[] }): Promise<void> {
  await traktFetch('/sync/watchlist', {
    method: 'POST',
    body: JSON.stringify(items),
  })
}

export async function removeFromWatchlist(items: { movies?: unknown[]; shows?: unknown[] }): Promise<void> {
  await traktFetch('/sync/watchlist/remove', {
    method: 'POST',
    body: JSON.stringify(items),
  })
}

export interface TraktPublicList {
  name: string
  description: string
  likes: number
  itemCount: number
  user: { username: string; ids: { slug: string } }
  ids: { trakt: number; slug: string }
}

export async function searchTraktPopularLists(query: string, limit = 20): Promise<TraktPublicList[]> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const encoded = encodeURIComponent(trimmed)
  const data = await traktFetch(`/search/list?query=${encoded}&limit=${limit}`) as any[]
  return data
    .filter((item) => item.type === 'list' && item.list)
    .map((item) => {
      const l = item.list
      return {
        name: l.name || '',
        description: l.description || '',
        likes: l.likes ?? 0,
        itemCount: l.item_count ?? 0,
        user: {
          username: l.user?.username || 'unknown',
          ids: { slug: l.user?.ids?.slug || '' },
        },
        ids: { trakt: l.ids?.trakt ?? 0, slug: l.ids?.slug || '' },
      }
    })
}

export async function getPublicListItems(username: string, listSlug: string): Promise<unknown[]> {
  return await traktFetch(`/users/${username}/lists/${listSlug}/items`) as unknown[]
}
