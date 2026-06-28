import type { ServerConfig } from './types.js'

function envInt(key: string, fallback: number): number {
  const v = process.env[key]
  if (v === undefined) return fallback
  const n = parseInt(v, 10)
  return isNaN(n) ? fallback : n
}

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key]
  if (v === undefined) return fallback
  return v === 'true' || v === '1'
}

export function loadConfig(): ServerConfig {
  return {
    port: envInt('PORT', 3009),
    publicUrl: envStr('PUBLIC_URL', 'http://localhost:3009'),
    wsPath: envStr('WS_PATH', '/ws'),
    roomEmptyTtl: envInt('ROOM_EMPTY_TTL_SECONDS', 600),
    roomInactiveTtl: envInt('ROOM_INACTIVE_TTL_SECONDS', 86400),
    reconnectGrace: envInt('RECONNECT_GRACE_SECONDS', 120),
    corsOrigin: envStr('CORS_ORIGIN', '*'),
    trustProxy: envBool('TRUST_PROXY', true),
    maxParticipants: envInt('MAX_PARTICIPANTS', 20),
    maxChatLength: envInt('MAX_CHAT_LENGTH', 500),
    rateLimitRoomsPerMinute: envInt('RATE_LIMIT_ROOMS_PER_MINUTE', 5),
    rateLimitMessagesPerMinute: envInt('RATE_LIMIT_MESSAGES_PER_MINUTE', 30),
  }
}
