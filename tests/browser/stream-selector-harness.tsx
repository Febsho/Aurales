import React from 'react'
import { createRoot } from 'react-dom/client'
import StreamSelector from '../../src/components/StreamSelector'
import { useAppStore } from '../../src/stores/appStore'
import { syncAddonsFromStore, type InstalledAddon } from '../../src/services/addons'

const addon: InstalledAddon = {
  manifest: {
    id: 'org.aurales.browser-test',
    name: 'Aurales Browser Test Addon',
    version: '1.0.0',
    resources: [{ name: 'stream', types: ['movie', 'series'] }],
    types: ['movie', 'series'],
    catalogs: [],
  },
  url: `${location.origin}/fixture-addon/manifest.json`,
  enabled: true,
}
syncAddonsFromStore([addon])
useAppStore.setState({ addons: [addon], autoPlayFirstStream: false })

const isSeries = new URLSearchParams(location.search).has('series')

function Harness() {
  const [episode, setEpisode] = React.useState({ season: 1, episode: 1 })
  const [open, setOpen] = React.useState(true)
  return <StreamSelector
    open={open}
    onClose={() => { document.body.dataset.selectorClosed = 'true'; setOpen(false) }}
    mediaType={isSeries ? 'series' : 'movie'}
    mediaId="tt0000001"
    title="Aurales Stream Selector Fixture"
    forceManualSelection={!isSeries || episode.episode === 1}
    seasonEpisode={isSeries ? episode : undefined}
    nextEpisodeHint={isSeries ? { season: 1, episode: episode.episode + 1 } : undefined}
    onNextEpisode={isSeries ? (season, next) => {
      document.body.dataset.episode = `${season}:${next}`
      setEpisode({ season, episode: next })
      setOpen(true)
    } : undefined}
  />
}

createRoot(document.getElementById('root')!).render(<Harness />)
