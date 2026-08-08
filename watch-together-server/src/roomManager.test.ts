import { describe, expect, it } from 'vitest'
import { createRoom, joinRoom, updateParticipantSourceStatus, updatePlayback } from './roomManager.js'
import type { ServerConfig } from './types.js'

const config: ServerConfig = {
  port: 3009,
  publicUrl: 'http://localhost:3009',
  wsPath: '/ws',
  roomEmptyTtl: 600,
  roomInactiveTtl: 86400,
  reconnectGrace: 120,
  corsOrigin: '*',
  trustProxy: false,
  maxParticipants: 20,
  maxChatLength: 500,
  rateLimitRoomsPerMinute: 5,
  rateLimitMessagesPerMinute: 30,
}

describe('watch together room source and playback state', () => {
  it('tracks private source readiness without receiving a stream URL', () => {
    const { room } = createRoom('Host', config)
    const joined = joinRoom(room.code, 'Guest', undefined, config)
    if ('error' in joined) throw new Error(joined.error)
    const participant = updateParticipantSourceStatus(room.id, joined.userId, 'ready')
    expect(participant?.isReady).toBe(true)
    expect(participant?.hasSelectedStream).toBe(true)
    expect(participant?.sourceStatus).toBe('ready')
  })

  it('assigns increasing sequences and authoritative server timestamps', () => {
    const { room } = createRoom('Host', config)
    const first = updatePlayback(room.id, { currentTime: 12, isPlaying: true })!
    const firstSequence = first.sequence!
    const second = updatePlayback(room.id, { currentTime: 13, isPlaying: true })!
    expect(second.sequence).toBe(firstSequence + 1)
    expect(second.serverTime).toBeTypeOf('number')
    expect(second.lastUpdatedAt).toBe(second.serverTime)
  })
})
