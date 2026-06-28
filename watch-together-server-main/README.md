# Orynt Watch Together Server

Public WebSocket room server for Orynt Watch Together. Syncs room state (media selection, playback, chat) between participants — does **not** stream video.

## Quick Start (Local)

```bash
npm install
npm run dev
```

Server starts at `http://localhost:3009` with WebSocket at `ws://localhost:3009/ws`.

## Deploy to Oracle VPS

### 1. Copy server to VPS

```bash
scp -r watch-together-server/ ubuntu@YOUR_VPS_IP:~/watch-together-server/
```

Or clone your repo on the VPS.

### 2. Install Docker

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-plugin
sudo systemctl enable docker
sudo usermod -aG docker $USER
# Log out and back in for group change
```

### 3. Configure environment

```bash
cd ~/watch-together-server
cp .env.example .env
nano .env
```

Set `PUBLIC_URL=https://watch.orynt.app` (or your domain).

### 4. Build and run

```bash
docker compose up -d --build
```

### 5. Verify

```bash
docker logs -f orynt-watch-together
curl http://localhost:3009/health
```

## Nginx Reverse Proxy (WSS/HTTPS)

### Install Nginx

```bash
sudo apt install -y nginx
```

### Create config

```bash
sudo nano /etc/nginx/sites-available/watch-together
```

```nginx
server {
    listen 80;
    server_name watch.orynt.app;

    location / {
        proxy_pass http://127.0.0.1:3009;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws {
        proxy_pass http://127.0.0.1:3009/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/watch-together /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### HTTPS with Certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d watch.orynt.app
```

After HTTPS is set up, the app connects to: `wss://watch.orynt.app/ws`

## Oracle VPS Firewall

Oracle Cloud requires ports open in **two places**:

### 1. Oracle Cloud Console

Go to **Networking → Virtual Cloud Networks → Security Lists** (or Network Security Groups).

Add ingress rules:
- TCP port 80 (HTTP)
- TCP port 443 (HTTPS)
- TCP port 3009 (optional, direct testing only)

### 2. Linux firewall on VPS

**UFW:**
```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3009/tcp   # optional, testing only
sudo ufw enable
```

**iptables:**
```bash
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 3009 -j ACCEPT
sudo netfilter-persistent save
```

**Production:** Expose only 80/443 publicly. Keep 3009 behind Nginx.

## API

### `GET /health`
```json
{ "ok": true, "uptime": 3600, "rooms": 2, "participants": 5, "connections": 5 }
```

### `POST /rooms`
```json
// Request
{ "name": "Justin" }

// Response (201)
{
  "roomId": "uuid",
  "code": "ABCD-1234",
  "userId": "uuid",
  "wsUrl": "wss://watch.orynt.app/ws",
  "inviteUrl": "orynt://watch/ABCD-1234"
}
```

### `GET /rooms/:code`
Returns room info (without chat history).

### `WebSocket: /ws`
See types in `src/types.ts` for all client→server and server→client events.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3009` | HTTP/WS listen port |
| `PUBLIC_URL` | `http://localhost:3009` | Public-facing URL (for WSS URL generation) |
| `WS_PATH` | `/ws` | WebSocket endpoint path |
| `ROOM_EMPTY_TTL_SECONDS` | `600` | Delete empty rooms after 10 min |
| `ROOM_INACTIVE_TTL_SECONDS` | `86400` | Delete inactive rooms after 24h |
| `RECONNECT_GRACE_SECONDS` | `120` | Keep disconnected user slot for 2 min |
| `CORS_ORIGIN` | `*` | Allowed CORS origins |
| `TRUST_PROXY` | `true` | Trust X-Forwarded-For header |
| `MAX_PARTICIPANTS` | `20` | Max participants per room |
| `MAX_CHAT_LENGTH` | `500` | Max chat message length |
| `RATE_LIMIT_ROOMS_PER_MINUTE` | `5` | Room creation rate limit per IP |
| `RATE_LIMIT_MESSAGES_PER_MINUTE` | `30` | Chat rate limit per user |
