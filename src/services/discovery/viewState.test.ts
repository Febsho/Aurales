import { describe,expect,it } from 'vitest'
import { discoveryViewState } from './viewState'
describe('Discovery page states',()=>{ it('shows skeletons before an uncached load settles',()=>expect(discoveryViewState(0,false)).toBe('loading')); it('shows cached content immediately',()=>expect(discoveryViewState(8,false)).toBe('content')); it('shows a retryable error after an empty failed load',()=>expect(discoveryViewState(0,true)).toBe('error')) })
