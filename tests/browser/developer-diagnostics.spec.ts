import { expect, test } from '@playwright/test'

test('browser developer diagnostics use the shared player and contain no native mpv controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: /select profile/i }).click()
  await page.evaluate(() => {
    window.history.pushState({}, '', '/developer')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })

  await expect(page.getByRole('heading', { name: 'Browser diagnostics' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Playback capabilities' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Request traffic' })).toBeVisible()
  await expect(page.getByLabel('Choose video')).toHaveAttribute('accept', 'video/*')
  await expect(page.getByText('MPV Path Status')).toHaveCount(0)
  await expect(page.getByText('Active MPV Session Properties')).toHaveCount(0)
})
