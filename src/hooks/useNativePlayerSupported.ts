import { useEffect, useState } from 'react'
import { resolveNativePlayerSupported } from '../services/player'
import { getPlatformCapabilities } from '../platform/capabilities'

export function useNativePlayerSupported(): boolean | undefined {
  const [supported, setSupported] = useState<boolean>()

  useEffect(() => {
    if (getPlatformCapabilities().platform === 'web') {
      setSupported(false)
      return
    }
    let cancelled = false
    resolveNativePlayerSupported().then((value) => {
      if (!cancelled) setSupported(value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return supported
}
