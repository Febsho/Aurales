import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import InAppPlayer from '../../src/components/InAppPlayer'

const params = new URLSearchParams(location.search)
const initialUrl = params.get('source')
if (!initialUrl) throw new Error('Harness requires a source query parameter')
const subtitleUrl = params.get('subtitle')

function clearPlaybackState() {
  delete document.body.dataset.playbackStarted
  delete document.body.dataset.playbackError
  delete document.body.dataset.errorPosition
  delete document.body.dataset.closed
  delete document.body.dataset.pickAnother
}

function Harness() {
  const [url, setUrl] = useState(initialUrl)
  const loadSource = (source: string) => {
    clearPlaybackState()
    setUrl(source)
  }
  ;(window as Window & { __loadNextSource?: () => void }).__loadNextSource = () => loadSource('/tests/browser/fixtures/h264-aac.mp4')
  ;(window as Window & { __loadPlaybackSource?: (source: string) => void }).__loadPlaybackSource = loadSource
  return <InAppPlayer
    url={url}
    title="Aurales player fixture"
    subtitle="Player integration test"
    subtitles={subtitleUrl ? [{ id: 'browser-subtitle', url: subtitleUrl, lang: 'en', label: 'External subtitle' }] : []}
    onClose={() => { document.body.dataset.closed = 'true' }}
    onPickAnother={() => { document.body.dataset.pickAnother = 'true' }}
    onPlaybackStarted={() => { document.body.dataset.playbackStarted = 'true' }}
    onPlaybackError={(message, position) => {
      document.body.dataset.playbackError = message
      document.body.dataset.errorPosition = String(position ?? 0)
    }}
  />
}

createRoot(document.getElementById('root')!).render(<Harness />)
