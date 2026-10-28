const ANILIST_AUTHORIZE_URL = 'https://anilist.co/api/v2/oauth/authorize'

/** Build AniList's public-client implicit-grant URL for the auth-pin redirect.
 * The client must have https://anilist.co/api/v2/oauth/pin registered as its
 * redirect URL in AniList developer settings. */
export function buildAniListBrowserAuthUrl(clientId: string): string {
  const cleanClientId = clientId.trim()
  if (!/^\d{1,20}$/.test(cleanClientId)) {
    throw new Error('Enter a valid AniList client ID for browser authorization.')
  }

  const url = new URL(ANILIST_AUTHORIZE_URL)
  url.searchParams.set('client_id', cleanClientId)
  url.searchParams.set('response_type', 'token')
  return url.toString()
}
