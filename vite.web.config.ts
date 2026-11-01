import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
const root = process.cwd()

export default defineConfig(({ command }) => ({
  configFile: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __AURALES_WEB__: 'true',
    'import.meta.env.VITE_WEB_BUILD': JSON.stringify(command === 'build' ? 'true' : 'false'),
  },
  resolve: {
    alias: [
      { find: '@tauri-apps/api/core', replacement: resolve(root, 'src/platform/web/tauriCore.ts') },
      { find: '@tauri-apps/api/event', replacement: resolve(root, 'src/platform/web/tauriEvent.ts') },
      { find: '@tauri-apps/api/window', replacement: resolve(root, 'src/platform/web/tauriWindow.ts') },
      { find: '@tauri-apps/plugin-updater', replacement: resolve(root, 'src/platform/web/tauriUpdater.ts') },
      { find: '@tauri-apps/plugin-process', replacement: resolve(root, 'src/platform/web/tauriProcess.ts') },
    ],
  },
  plugins: [
    react(), tailwindcss(),
    {
      name: 'aurales-web-platform-adapters',
      enforce: 'pre',
      resolveId(source) {
        if (source.endsWith('/platform/imageCacheAdapter') || source === '../platform/imageCacheAdapter') {
          return resolve(root, 'src/platform/web/imageCacheAdapter.ts')
        }
        if (source === './addonCatalogLoader' || source.endsWith('/addonCatalogLoader')) {
          return resolve(root, 'src/platform/web/addonCatalogLoader.ts')
        }
        if (source === '../services/player' || source.endsWith('/services/player')) {
          return resolve(root, 'src/platform/web/player.ts')
        }
        if (source.endsWith('/NativeMpvPlayer') || source === './NativeMpvPlayer') {
          return resolve(root, 'src/components/WebNativeMpvPlayer.tsx')
        }
        if (source === './pages/DeveloperPage' || source.endsWith('/pages/DeveloperPage')) {
          return resolve(root, 'src/pages/WebDeveloperPage.tsx')
        }
      },
    },
  ],
  build: { outDir: 'dist-web', emptyOutDir: true, target: 'esnext' },
  server: { port: 5174, strictPort: true },
}))
