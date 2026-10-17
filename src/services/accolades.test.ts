import { describe, expect, it } from 'vitest'
import { accoladeFromAwards, editorialAccolade, isGenericAwardAccolade } from './accolades'

describe('accoladeFromAwards', () => {
  it('prioritizes major wins over generic totals', () => {
    expect(accoladeFromAwards('Won 59 Primetime Emmys. 396 wins & 655 nominations total'))
      .toBe('Winner of 59 Primetime Emmy® Awards')
  })

  it('formats singular and plural major nominations', () => {
    expect(accoladeFromAwards('Nominated for 1 Oscar. 2 wins & 8 nominations total'))
      .toBe('Academy Award® Nominee')
    expect(accoladeFromAwards('Nominated for 4 Golden Globes. 3 wins & 12 nominations total'))
      .toBe('4× Golden Globe® Nominee')
  })

  it('uses only substantial generic award totals', () => {
    expect(accoladeFromAwards('8 wins & 3 nominations total')).toBe('Winner of 8 Awards')
    expect(accoladeFromAwards('1 win & 2 nominations total')).toBeNull()
    expect(accoladeFromAwards('N/A')).toBeNull()
  })
})

describe('editorialAccolade', () => {
  const now = new Date('2026-07-26T12:00:00Z')

  it('identifies current releases and returning shows', () => {
    expect(editorialAccolade({ type: 'movie', year: 2026 }, now)).toBe('New Movie')
    expect(editorialAccolade({ type: 'movie', year: 2025, releaseDate: '2026-06-01' }, now)).toBe('In Cinema')
    expect(editorialAccolade({ type: 'series', year: 2020, status: 'Returning Series' }, now)).toBe('Returning')
  })

  it('recognizes series and creator highlights', () => {
    expect(editorialAccolade({ type: 'series', year: 2025, seriesType: 'Miniseries' }, now)).toBe('Limited Series')
    expect(editorialAccolade({ type: 'series', year: 2020, latestSeasonAirDate: '2026-05-04' }, now)).toBe('New Season')
    expect(editorialAccolade({ type: 'movie', year: 2008, crewNames: ['Christopher Nolan'] }, now)).toBe('Nolan Movie')
  })

  it('uses top rated only with a meaningful vote sample', () => {
    expect(editorialAccolade({ type: 'movie', year: 1994, rating: 8.7, voteCount: 50_000 }, now)).toBe('Top Rated')
    expect(editorialAccolade({ type: 'movie', year: 1994, rating: 8.7, voteCount: 200 }, now)).toBeNull()
  })

  it('distinguishes generic award totals from major awards', () => {
    expect(isGenericAwardAccolade('Winner of 7 Awards')).toBe(true)
    expect(isGenericAwardAccolade('Academy Award® Winner')).toBe(false)
  })
})
