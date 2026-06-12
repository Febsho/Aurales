export type StreamRegexTagStyle = 'filled' | 'bordered' | 'filled and bordered' | string

export interface StreamRegexFilter {
  borderColor: string
  groupId: string
  id: string
  imageURL: string
  isEnabled: boolean
  name: string
  pattern: string
  tagColor: string
  tagStyle: StreamRegexTagStyle
  textColor: string
  type: 'filter' | string
}

export interface StreamRegexGroup {
  color: string
  id: string
  isExpanded: boolean
  name: string
}

export interface StreamRegexFilterConfig {
  filters: StreamRegexFilter[]
  groups: StreamRegexGroup[]
}

export interface MatchedStreamRegexFilter {
  filter: StreamRegexFilter
  group?: StreamRegexGroup
}

const STORAGE_KEY = 'orynt_stream_regex_filter_config'
const ICON_BASE = 'https://raw.githubusercontent.com/9mousaa/BetterFormatter/main/images'

function pctFilters(): StreamRegexFilter[] {
  return Array.from({ length: 100 }, (_, index) => {
    const value = 100 - index
    return {
      borderColor: '#FF858283',
      groupId: 'gp',
      id: `pct-${value}`,
      imageURL: '',
      isEnabled: true,
      name: `${value}%`,
      pattern: `(?<![0-9])${value}%`,
      tagColor: '#33FFFFFF',
      tagStyle: 'filled and bordered',
      textColor: '#FFFFFF',
      type: 'filter',
    }
  })
}

export const DEFAULT_STREAM_REGEX_FILTER_CONFIG: StreamRegexFilterConfig = {
  filters: [
    ...pctFilters(),
    {
      borderColor: '#FF858283',
      groupId: 'gq',
      id: 'q-r',
      imageURL: `${ICON_BASE}/mono-remux.png`,
      isEnabled: true,
      name: 'Remux',
      pattern: '(?i)\\bremux\\b',
      tagColor: '#33FFFFFF',
      tagStyle: 'filled and bordered',
      textColor: '#FFFFFF',
      type: 'filter',
    },
    {
      borderColor: '#FF858283',
      groupId: 'gq',
      id: 'q-b',
      imageURL: `${ICON_BASE}/mono-bluray.png`,
      isEnabled: true,
      name: 'BluRay',
      pattern: '(?i)^(?=.*(?:bluray|blu-ray))(?!.*remux)',
      tagColor: '#33FFFFFF',
      tagStyle: 'filled and bordered',
      textColor: '#FFFFFF',
      type: 'filter',
    },
    {
      borderColor: '#FF858283',
      groupId: 'gq',
      id: 'q-w',
      imageURL: `${ICON_BASE}/mono-webdl.png`,
      isEnabled: true,
      name: 'WebDL',
      pattern: '(?i)\\b(?:web[-_. ]?dl|webdl|webrip|web-rip)\\b',
      tagColor: '#33FFFFFF',
      tagStyle: 'filled and bordered',
      textColor: '#FFFFFF',
      type: 'filter',
    },
    {
      borderColor: '#FF858283',
      groupId: 'gr',
      id: 'r-4k',
      imageURL: `${ICON_BASE}/4k.png`,
      isEnabled: true,
      name: '4K',
      pattern: '(?i)^(?=.*(?:2160[pi]?|4k|uhd))(?!.*(?:1080[pi]?|720[pi]?))',
      tagColor: '#33FFFFFF',
      tagStyle: 'filled and bordered',
      textColor: '#FFFFFF',
      type: 'filter',
    },
    {
      borderColor: '#FF858283',
      groupId: 'gr',
      id: 'r-1080',
      imageURL: `${ICON_BASE}/1080p.png`,
      isEnabled: true,
      name: '1080p',
      pattern: '(?i)\\b1080[pi]?\\b',
      tagColor: '#33FFFFFF',
      tagStyle: 'filled and bordered',
      textColor: '#FFFFFF',
      type: 'filter',
    },
    {
      borderColor: '#FF858283',
      groupId: 'gr',
      id: 'r-720',
      imageURL: `${ICON_BASE}/720p.png`,
      isEnabled: true,
      name: '720p',
      pattern: '(?i)\\b720[pi]?\\b',
      tagColor: '#33FFFFFF',
      tagStyle: 'filled and bordered',
      textColor: '#FFFFFF',
      type: 'filter',
    },
    {
      borderColor: '#FF858283',
      groupId: 'gv',
      id: 'v-hdr10p',
      imageURL: `${ICON_BASE}/HDR10Plus.png`,
      isEnabled: true,
      name: 'HDR10+',
      pattern: '(?i)hdr[\\s._-]?10[\\s._-]?(?:\\+|plus|p)',
      tagColor: '#33FFFFFF',
      tagStyle: 'filled and bordered',
      textColor: '#FFFFFF',
      type: 'filter',
    },
    {
      borderColor: '#FF858283',
      groupId: 'gv',
      id: 'v-hdr10',
      imageURL: `${ICON_BASE}/HDR10.png`,
      isEnabled: true,
      name: 'HDR10',
      pattern: '(?i)^(?=.*hdr[\\s._-]?10)(?!.*hdr[\\s._-]?10[\\s._-]?(?:\\+|plus|p))',
      tagColor: '#33FFFFFF',
      tagStyle: 'filled and bordered',
      textColor: '#FFFFFF',
      type: 'filter',
    },
    {
      borderColor: '#FF858283',
      groupId: 'gv',
      id: 'v-hdr',
      imageURL: `${ICON_BASE}/HDR.png`,
      isEnabled: true,
      name: 'HDR',
      pattern: '(?i)^(?=.*\\bHDR\\b)(?!.*hdr[\\s._-]?10)',
      tagColor: '#33FFFFFF',
      tagStyle: 'filled and bordered',
      textColor: '#FFFFFF',
      type: 'filter',
    },
    {
      borderColor: '#00000000',
      groupId: 'gv',
      id: 'a-dv',
      imageURL: `${ICON_BASE}/vision.png`,
      isEnabled: true,
      name: 'DV',
      pattern: '(?i)\\b(?:dv|dovi|dolby[\\s._-]?vision)\\b',
      tagColor: '#00000000',
      tagStyle: 'filled and bordered',
      textColor: '#FFFFFF',
      type: 'filter',
    },
    {
      borderColor: '#00000000',
      groupId: 'ga',
      id: 'a-at',
      imageURL: `${ICON_BASE}/atmos.png`,
      isEnabled: true,
      name: 'Atmos',
      pattern: '(?i)\\batmos\\b',
      tagColor: '#00000000',
      tagStyle: 'filled and bordered',
      textColor: '#FFFFFF',
      type: 'filter',
    },
    {
      borderColor: '#00000000',
      groupId: 'ga',
      id: 'a-th',
      imageURL: `${ICON_BASE}/truehd.png`,
      isEnabled: true,
      name: 'TrueHD',
      pattern: '(?i)^(?=.*\\btrue[\\s._-]?hd\\b)(?!.*\\batmos\\b)',
      tagColor: '#00000000',
      tagStyle: 'filled and bordered',
      textColor: '#FFFFFF',
      type: 'filter',
    },
    {
      borderColor: '#00000000',
      groupId: 'ga',
      id: 'a-dp',
      imageURL: `${ICON_BASE}/digitalplus.png`,
      isEnabled: true,
      name: 'DD+',
      pattern: '(?i)\\b(?:ddp|dd\\+|eac-?3|e-?ac-?3)\\b',
      tagColor: '#00000000',
      tagStyle: 'filled and bordered',
      textColor: '#FFFFFF',
      type: 'filter',
    },
    {
      borderColor: '#00000000',
      groupId: 'gc',
      id: 'ch-71',
      imageURL: `${ICON_BASE}/7dot1.png`,
      isEnabled: true,
      name: '7.1',
      pattern: '[^0-9][7-8][. ][01](?![0-9])',
      tagColor: '#00000000',
      tagStyle: 'filled and bordered',
      textColor: '#FFFFFF',
      type: 'filter',
    },
    {
      borderColor: '#00000000',
      groupId: 'gc',
      id: 'ch-51',
      imageURL: `${ICON_BASE}/5dot1.png`,
      isEnabled: true,
      name: '5.1',
      pattern: '^(?=.*[^0-9]5[. ][01](?![0-9]))(?!.*[^0-9][7-8][. ][01](?![0-9]))',
      tagColor: '#00000000',
      tagStyle: 'filled and bordered',
      textColor: '#FFFFFF',
      type: 'filter',
    },
  ],
  groups: [
    { color: '#27C04F', id: 'gp', isExpanded: true, name: 'Score' },
    { color: '#27C04F', id: 'gq', isExpanded: true, name: 'Quality' },
    { color: '#FFBE01', id: 'gr', isExpanded: true, name: 'Resolution' },
    { color: '#FF6B6B', id: 'gv', isExpanded: true, name: 'Visual' },
    { color: '#45B7D1', id: 'ga', isExpanded: true, name: 'Audio' },
    { color: '#FFD700', id: 'gc', isExpanded: true, name: 'Channels' },
  ],
}

export function loadStreamRegexFilterConfig(): StreamRegexFilterConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? validateStreamRegexFilterConfig(JSON.parse(raw)) : DEFAULT_STREAM_REGEX_FILTER_CONFIG
  } catch {
    return DEFAULT_STREAM_REGEX_FILTER_CONFIG
  }
}

export function saveStreamRegexFilterConfig(config: StreamRegexFilterConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(validateStreamRegexFilterConfig(config), null, 2))
}

export function resetStreamRegexFilterConfig(): StreamRegexFilterConfig {
  saveStreamRegexFilterConfig(DEFAULT_STREAM_REGEX_FILTER_CONFIG)
  return DEFAULT_STREAM_REGEX_FILTER_CONFIG
}

export function validateStreamRegexFilterConfig(value: unknown): StreamRegexFilterConfig {
  if (!value || typeof value !== 'object') throw new Error('Config must be an object.')
  const config = value as Partial<StreamRegexFilterConfig>
  if (!Array.isArray(config.filters)) throw new Error('Config must contain a filters array.')
  if (!Array.isArray(config.groups)) throw new Error('Config must contain a groups array.')

  return {
    filters: config.filters
      .filter((filter): filter is StreamRegexFilter => !!filter && typeof filter === 'object')
      .map((filter) => ({
        borderColor: String(filter.borderColor || '#80FFFFFF'),
        groupId: String(filter.groupId || ''),
        id: String(filter.id || filter.name || crypto.randomUUID()),
        imageURL: String(filter.imageURL || ''),
        isEnabled: filter.isEnabled !== false,
        name: String(filter.name || 'Tag'),
        pattern: String(filter.pattern || ''),
        tagColor: String(filter.tagColor || '#33FFFFFF'),
        tagStyle: String(filter.tagStyle || 'filled and bordered'),
        textColor: String(filter.textColor || '#FFFFFF'),
        type: String(filter.type || 'filter'),
      }))
      .filter((filter) => filter.pattern.trim().length > 0),
    groups: config.groups
      .filter((group): group is StreamRegexGroup => !!group && typeof group === 'object')
      .map((group) => ({
        color: String(group.color || '#27C04F'),
        id: String(group.id || crypto.randomUUID()),
        isExpanded: group.isExpanded !== false,
        name: String(group.name || 'Group'),
      })),
  }
}

export function matchStreamRegexFilters(text: string, config = loadStreamRegexFilterConfig()): MatchedStreamRegexFilter[] {
  const groups = new Map(config.groups.map((group) => [group.id, group]))
  const matches: MatchedStreamRegexFilter[] = []

  for (const filter of config.filters) {
    if (!filter.isEnabled || filter.type !== 'filter') continue
    const regex = compileFilterRegex(filter.pattern)
    if (!regex) continue
    try {
      if (regex.test(text)) matches.push({ filter, group: groups.get(filter.groupId) })
    } catch {
      // Ignore runtime regex failures so one bad tag cannot break stream selection.
    }
  }

  return matches
}

export function compileFilterRegex(pattern: string): RegExp | null {
  try {
    let source = pattern.trim()
    let flags = ''
    if (source.includes('(?i)')) {
      source = source.replaceAll('(?i)', '')
      flags += 'i'
    }
    return new RegExp(source, flags)
  } catch {
    return null
  }
}

export function cssColorFromFilterColor(value: string, fallback = 'transparent'): string {
  if (!value) return fallback
  const color = value.trim()
  if (/^#[0-9a-f]{8}$/i.test(color)) {
    const alpha = color.slice(1, 3)
    const rgb = color.slice(3)
    return `#${rgb}${alpha}`
  }
  return color
}
