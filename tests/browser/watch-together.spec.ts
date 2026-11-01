import { expect, test } from '@playwright/test'

test('browser Watch Together creates a room over the shared WebSocket client', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.addInitScript(() => {
    localStorage.setItem('aurales_wt_serverUrl', JSON.stringify('ws://127.0.0.1:8189/ws'))
    // Profile selection has its own smoke coverage. Keep this integration
    // focused on routing and room creation instead of asynchronous switching.
    localStorage.setItem('aurales_skip_profile_picker', 'true')
  })

  page.routeWebSocket('ws://127.0.0.1:8189/ws', (socket) => {
    socket.onMessage((message) => {
      if (typeof message !== 'string') return
      const event = JSON.parse(message) as { type?: string; roomCode?: string; name?: string; roomSettings?: { everyoneCanControl?: boolean; requireReadyCheck?: boolean } }
      if (event.type !== 'ROOM_JOIN' || event.roomCode !== '') return
      const now = Date.now()
      socket.send(JSON.stringify({
        type: 'ROOM_CREATED',
        userId: 'browser-user-1',
        room: {
          id: 'browser-room-1',
          code: 'WEBR-1234',
          hostUserId: 'browser-user-1',
          playback: { status: 'idle', currentTime: 0, isPlaying: false, lastUpdatedAt: now },
          participants: [{
            id: 'browser-user-1',
            name: event.name,
            isHost: true,
            isReady: false,
            hasSelectedStream: false,
            hasMediaAvailable: false,
            status: 'connected',
          }],
          chat: [],
          everyoneCanControl: Boolean(event.roomSettings?.everyoneCanControl),
          requireReadyCheck: Boolean(event.roomSettings?.requireReadyCheck),
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        },
      }))
    })
  })

  await page.goto('/watch-together')
  await expect(page.getByRole('heading', { name: 'Movie night, every screen.' })).toBeVisible()
  await page.getByRole('button', { name: /start a room/i }).click()
  await page.getByLabel('Your nickname').fill('Browser Host')
  await page.getByRole('button', { name: 'Create Room' }).click()

  await expect(page.getByRole('button', { name: /Room WEBR-1234 is active/ })).toBeVisible()
  await expect(page.getByText('Browser Host', { exact: false })).toBeVisible()
  await expect(page.getByText('connected', { exact: true })).toBeVisible()
  expect(pageErrors).toEqual([])
})
