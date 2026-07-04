// Secondary dev-server config used only for browser preview/verification —
// runs on 5175 so it never collides with the main `tauri dev` session on 5173.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'fs'

const tauriConf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf-8'))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(tauriConf.version),
  },
  clearScreen: false,
  server: {
    port: 5175,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
})
