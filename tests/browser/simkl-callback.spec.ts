import { expect, test } from '@playwright/test'

test('Simkl browser callback validates PKCE state and stores the connected account', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('simkl_oauth_v2', JSON.stringify({
      verifier: 'test-verifier',
      state: 'state-for-browser-test',
      redirectUri: `${location.origin}/auth/simkl/callback`,
    }))
    localStorage.setItem('simkl_v2_client_id', 'public-test-client')
  })
  await page.route('https://api.simkl.com/oauth2/token', async (route) => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().postData()).toContain('code_verifier=test-verifier')
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ access_token: 'browser-access', refresh_token: 'browser-refresh', expires_in: 3600 }) })
  })
  await page.route('https://api.simkl.com/users/settings', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer browser-access')
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { id: 123, username: 'browser-user' } }) })
  })

  await page.goto('/auth/simkl/callback?code=browser-code&state=state-for-browser-test&iss=https%3A%2F%2Fsimkl.com')
  await expect(page.getByRole('status')).toHaveText('Connected as browser-user.')
  await expect(page).toHaveURL(/\/auth\/simkl\/callback$/)
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('simkl_token') || 'null'))
  expect(token).toMatchObject({ accessToken: 'browser-access', refreshToken: 'browser-refresh' })
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('simkl_account') || 'null'))).toMatchObject({ id: '123', username: 'browser-user' })
})
