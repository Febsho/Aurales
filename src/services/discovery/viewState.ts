export type DiscoveryViewState='loading'|'content'|'error'
export function discoveryViewState(candidateCount:number,initialWaitComplete:boolean):DiscoveryViewState { if(candidateCount>0)return 'content'; return initialWaitComplete?'error':'loading' }
