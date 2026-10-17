import { useEffect, useState } from 'react'
import { resolveNativePlayerSupported } from '../services/player'

export function useNativePlayerSupported(): boolean | undefined {
  const [supported, setSupported] = useState<boolean>()

  useEffect(() => {
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
