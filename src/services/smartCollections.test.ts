import { describe, expect, it } from 'vitest'
import type { HomeRowConfig } from '../types'
import { getHomeShelfRows, getSmartCollections, newSmartCollectionDefaults, SMART_COLLECTION_TEMPLATES } from './smartCollections'

const row = (id: string, sourceType: HomeRowConfig['sourceType'], enabled: boolean, layout: HomeRowConfig['layout'] = 'poster'): HomeRowConfig => ({ id, title: id, sourceType, enabled, layout, order: 0 })

describe('smart collections', () => {
  it('ships six stable, editable templates', () => {
    expect(SMART_COLLECTION_TEMPLATES).toHaveLength(6)
    expect(new Set(SMART_COLLECTION_TEMPLATES.map((template) => template.id)).size).toBe(6)
    expect(SMART_COLLECTION_TEMPLATES.every((template) => template.rules && template.contentType)).toBe(true)
  })

  it('keeps hidden discover rows in the collection library', () => {
    expect(getSmartCollections([row('hidden', 'discover', false), row('addon', 'addon', true)]).map((item) => item.id)).toEqual(['hidden'])
  })

  it('only includes enabled collections among home shelves', () => {
    const rows = [row('hidden', 'discover', false), row('visible', 'discover', true), row('addon', 'addon', false), row('hero', 'addon', true, 'hero')]
    expect(getHomeShelfRows(rows).map((item) => item.id)).toEqual(['visible', 'addon'])
  })

  it('defaults new smart collections to hidden from Home', () => {
    expect(newSmartCollectionDefaults()).toEqual({ enabled: false })
  })
})
