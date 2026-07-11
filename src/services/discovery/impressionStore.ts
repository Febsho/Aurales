import type { SearchResult } from '../../types'
import { mediaKey } from './recommendationEngine'

const KEY='aurales_discovery_impressions_v1'
export function loadRecommendationImpressions(): Record<string,number> { try { const value=JSON.parse(localStorage.getItem(KEY)||'{}'); return value&&typeof value==='object'?value:{} } catch { return {} } }
export function recordRecommendationImpressions(items: SearchResult[]): void { const current=loadRecommendationImpressions(); for(const item of items) current[mediaKey(item)]=(current[mediaKey(item)]||0)+1; const entries=Object.entries(current).sort((a,b)=>b[1]-a[1]).slice(0,1000); localStorage.setItem(KEY,JSON.stringify(Object.fromEntries(entries))) }
