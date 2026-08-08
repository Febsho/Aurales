import { useSyncExternalStore } from 'react'
import { getLocalWatchlist, subscribeLocalWatchlist } from '../services/localWatchlist'

export function useLocalWatchlist() {
  return useSyncExternalStore(subscribeLocalWatchlist, getLocalWatchlist, getLocalWatchlist)
}
