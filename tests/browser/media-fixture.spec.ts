import { expect, test } from '@playwright/test'

test('browser plays and seeks a supported fixture over HTTP range requests', async ({ page }, testInfo) => {
  const useMp4 = testInfo.project.name.includes('webkit')
  const fixture = useMp4 ? 'h264-aac.mp4' : 'vp8-opus.webm'
  const seekTarget = useMp4 ? 1.5 : 6
  const mediaResponse = page.waitForResponse((response) => response.url().endsWith(`/${fixture}`))
  await page.goto(`/tests/browser/media-fixture.html${useMp4 ? '?format=mp4' : ''}`)

  const response = await mediaResponse
  expect(response.status()).toBe(206)
  expect(response.headers()['content-type']).toContain(useMp4 ? 'video/mp4' : 'video/webm')

  const state = page.locator('#media-state')
  await expect(state).toContainText('"played":true', { timeout: 10_000 })
  await expect(state).toContainText(`"duration":${useMp4 ? 3 : 12}`)
  await expect(state).toContainText('"seekableRanges":1')
  await expect.poll(async () => {
    const text = await state.textContent()
    return JSON.parse(text || '{}').currentTime as number
  }).toBeGreaterThanOrEqual(seekTarget)
  await expect.poll(async () => {
    const text = await state.textContent()
    return JSON.parse(text || '{}').currentTime as number
  }).toBeLessThan(seekTarget + 0.5)
  await expect(state).toContainText('"error":null')
})
