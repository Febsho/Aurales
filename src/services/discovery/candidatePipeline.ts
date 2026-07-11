export interface CandidateSource<T> { id:string; load:()=>Promise<T[]> }
export interface CandidateSourceResult<T> { items:T[]; errors:Array<{sourceId:string;message:string}> }

/** Runs independent sources concurrently; one provider failure never discards successful candidates. */
export async function collectCandidateSources<T>(sources:CandidateSource<T>[]):Promise<CandidateSourceResult<T>> {
  const settled=await Promise.allSettled(sources.map((source)=>source.load()))
  const items:T[]=[]; const errors:CandidateSourceResult<T>['errors']=[]
  settled.forEach((result,index)=>{ if(result.status==='fulfilled')items.push(...result.value); else errors.push({sourceId:sources[index].id,message:result.reason instanceof Error?result.reason.message:String(result.reason)}) })
  return {items,errors}
}
