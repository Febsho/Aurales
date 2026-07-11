import { describe,expect,it,vi } from 'vitest'
import { collectCandidateSources } from './candidatePipeline'

describe('discovery candidate pipeline',()=>{
  it('keeps successful sections when another API source fails',async()=>{ const result=await collectCandidateSources([{id:'cached',load:vi.fn().mockResolvedValue([1,2])},{id:'offline',load:vi.fn().mockRejectedValue(new Error('offline'))}]); expect(result.items).toEqual([1,2]); expect(result.errors).toEqual([{sourceId:'offline',message:'offline'}]) })
  it('does not invoke a source more than once per collection',async()=>{ const load=vi.fn().mockResolvedValue([1]); await collectCandidateSources([{id:'one',load}]); expect(load).toHaveBeenCalledTimes(1) })
})
