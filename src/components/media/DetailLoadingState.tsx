import { useState } from 'react'
import { cachedImage, retryImageFromSource } from '../../services/imageCache'

interface DetailLoadingStateProps {
  logo?: string
  title?: string
  backdrop?: string
  poster?: string
  error?: string
  onRetry?: () => void
}

export default function DetailLoadingState({ logo, title, backdrop, poster, error, onRetry }: DetailLoadingStateProps) {
  const [logoFailed, setLogoFailed] = useState(false)
  const background = backdrop || poster

  return (
    <div className="relative flex h-full min-h-[60vh] items-center justify-center overflow-hidden bg-black">
      {background && (
        <img
          src={cachedImage(background)}
          alt=""
          className="absolute inset-0 h-full w-full object-cover opacity-15"
          decoding="async"
          draggable={false}
          onError={(event) => { retryImageFromSource(event.currentTarget, background) }}
        />
      )}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.04),transparent_42%),linear-gradient(to_bottom,rgba(0,0,0,0.45),#000)]" />

      <div className="relative z-10 flex max-w-[min(70vw,520px)] flex-col items-center gap-7 px-8 text-center">
        {logo && !logoFailed ? (
          <img
            src={cachedImage(logo)}
            alt={title || ''}
            className="max-h-36 max-w-full object-contain drop-shadow-[0_8px_30px_rgba(0,0,0,0.8)]"
            onError={(event) => {
              if (!retryImageFromSource(event.currentTarget, logo)) setLogoFailed(true)
            }}
            decoding="async"
            draggable={false}
          />
        ) : title ? (
          <h1 className="text-3xl font-black tracking-tight text-white/90 md:text-5xl">{title}</h1>
        ) : null}

        {error ? <div role="alert" className="flex flex-col items-center gap-4 text-white/80">
          <p>{error}</p>
          {onRetry && <button onClick={onRetry} className="rounded-lg bg-white/15 px-5 py-2 text-white hover:bg-white/25">Try again</button>}
        </div> : <div
          className="h-7 w-7 animate-spin rounded-full border-2 border-white/15 border-t-accent"
          role="status"
          aria-label="Loading details"
        />}
      </div>
    </div>
  )
}
