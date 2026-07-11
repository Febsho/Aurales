import http from 'http'
import { loadConfig } from './config.js'
import { setupWebSocket, getConnectedClientCount } from './websocket.js'
import {
  createRoom as createRoomInManager,
  getRoomByCode,
  getRoomCount,
  getParticipantCount,
  roomToPublic,
  cleanupRooms,
} from './roomManager.js'
import { cleanupRateLimits } from './rateLimit.js'

const config = loadConfig()
const startedAt = Date.now()

// ── HTTP server ───────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // CORS
  const origin = config.corsOrigin
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

  // GET /health
  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, {
      ok: true,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      rooms: getRoomCount(),
      participants: getParticipantCount(),
      connections: getConnectedClientCount(),
    })
    return
  }

  // POST /rooms
  if (req.method === 'POST' && url.pathname === '/rooms') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try {
        const data = JSON.parse(body)
        const name = (data.name as string || '').trim().slice(0, 32) || 'Host'
        const { room, userId } = createRoomInManager(name, config)

        const wsProtocol = config.publicUrl.startsWith('https') ? 'wss' : 'ws'
        const wsHost = config.publicUrl.replace(/^https?:\/\//, '')
        const wsUrl = `${wsProtocol}://${wsHost}${config.wsPath}`

        json(res, 201, {
          roomId: room.id,
          code: room.code,
          userId,
          wsUrl,
          inviteUrl: `aurales://watch/${room.code}`,
        })
      } catch {
        json(res, 400, { error: 'Invalid JSON body' })
      }
    })
    return
  }

  // GET /rooms/:code
  if (req.method === 'GET' && url.pathname.startsWith('/rooms/')) {
    const code = url.pathname.slice(7).toUpperCase()
    const room = getRoomByCode(code)
    if (!room) {
      json(res, 404, { error: 'Room not found' })
      return
    }
    json(res, 200, roomToPublic(room))
    return
  }

  // 404
  json(res, 404, { error: 'Not found' })
})

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

// ── WebSocket ─────────────────────────────────────────────────────────────

setupWebSocket(server, config)

// ── Cleanup timer ─────────────────────────────────────────────────────────

setInterval(() => {
  const removed = cleanupRooms(config)
  cleanupRateLimits()
  if (removed > 0) {
    console.log(`[${new Date().toISOString()}] [CLEANUP] Removed ${removed} stale rooms`)
  }
}, 30_000)

// ── Start ─────────────────────────────────────────────────────────────────

server.listen(config.port, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║       Aurales Watch Together Server              ║
╠══════════════════════════════════════════════════╣
║  HTTP:  http://0.0.0.0:${String(config.port).padEnd(25)}║
║  WS:    ws://0.0.0.0:${String(config.port + config.wsPath).padEnd(27)}║
║  Public: ${config.publicUrl.padEnd(39)}║
╚══════════════════════════════════════════════════╝
  `)
})
