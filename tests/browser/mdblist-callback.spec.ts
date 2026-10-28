import { expect, test } from '@playwright/test'

test('MDBList browser callback validates state and stores the account token', async ({ page }) => {
  const state = 'mdblist-state-123'
  await page.addInitScript(({ expectedState }) => {
    sessionStorage.setItem('mdblist_oauth_pkce_v1', JSON.stringify({
      codeVerifier: 'verifier-value-for-pkce',
      state: expectedState,
      redirectUri: new URL('/auth/mdblist/callback', location.origin).toString(),
    }))
  }, { expectedState: state })
  let postedBody = ''
  await page.route('https://api.mdblist.com/oauth/token/', async (route) => {
    postedBody = route.request().postData() || ''
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ access_token: 'browser-account-token', refresh_token: 'refresh-token', expires_in: 3600 }) })
  })

  await page.goto(`/auth/mdblist/callback?code=authorization-code&state=${state}`)
  await expect(page.getByRole('status')).toHaveText('MDBList is connected to this browser.')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('mdblist_oauth_tokens'))).toContain('browser-account-token')
  expect(new URLSearchParams(postedBody).get('code_verifier')).toBe('verifier-value-for-pkce')
  expect(new URLSearchParams(postedBody).get('redirect_uri')).toBe(await page.evaluate(() => new URL('/auth/mdblist/callback', location.origin).toString()))
  expect(await page.evaluate(() => sessionStorage.getItem('mdblist_oauth_pkce_v1'))).toBeNull()
})

test('MDBList callback can exchange its code through the configured trusted worker', async ({ page }) => {
  const state = 'mdblist-worker-state-123'
  await page.addInitScript(({ expectedState }) => {
    sessionStorage.setItem('mdblist_oauth_pkce_v1', JSON.stringify({
      codeVerifier: 'worker-flow-verifier',
      state: expectedState,
      redirectUri: new URL('/auth/mdblist/callback', location.origin).toString(),
    }))
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({ baseUrl: location.origin, apiKey: 'w'.repeat(32) }))
  }, { expectedState: state })
  let providerForm = ''
  await page.route('**/v1/providers/mdblist', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}') as { body?: string; contentType?: string; path?: string }
    providerForm = body.body || ''
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 200, ok: true, body: JSON.stringify({ access_token: 'worker-account-token', refresh_token: 'worker-refresh-token', expires_in: 3600 }) }),
    })
  })

  await page.goto(`/auth/mdblist/callback?code=worker-authorization-code&state=${state}`)
  await expect(page.getByRole('status')).toHaveText('MDBList is connected to this browser.')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('mdblist_oauth_tokens'))).toContain('worker-account-token')
  expect(new URLSearchParams(providerForm).get('code_verifier')).toBe('worker-flow-verifier')
})
