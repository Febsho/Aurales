function toVttTimestamp(value: string): string | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})$/)
  if (!match) return null
  const [, hours, minutes, seconds, fraction] = match
  return `${hours.padStart(2, '0')}:${minutes}:${seconds}.${fraction.padEnd(3, '0').slice(0, 3)}`
}

function convertSrt(input: string): string {
  const normalized = input.replace(/^\uFEFF/, '').replace(/\r/g, '').replace(/(\d{1,2}:\d{2}:\d{2}),([\d]{1,3})/g, '$1.$2')
  return `WEBVTT\n\n${normalized.trimStart()}`
}

function convertAss(input: string): string {
  let inEvents = false
  let format: string[] = []
  const cues: string[] = []
  for (const rawLine of input.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n')) {
    const line = rawLine.trimEnd()
    if (/^\s*\[Events\]\s*$/i.test(line)) { inEvents = true; continue }
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) { inEvents = false; continue }
    if (!inEvents) continue
    const formatMatch = line.match(/^\s*Format\s*:\s*(.+)$/i)
    if (formatMatch) { format = formatMatch[1].split(',').map((field) => field.trim().toLowerCase()); continue }
    if (!/^\s*Dialogue\s*:/i.test(line) || format.length === 0) continue
    const eventText = line.replace(/^\s*Dialogue\s*:\s*/i, '')
    const textIndex = format.indexOf('text')
    if (textIndex < 0) continue
    const fields: string[] = []
    let remainder = eventText
    for (let index = 0; index < textIndex; index += 1) {
      const comma = remainder.indexOf(',')
      if (comma < 0) { fields.length = 0; break }
      fields.push(remainder.slice(0, comma))
      remainder = remainder.slice(comma + 1)
    }
    if (fields.length !== textIndex || remainder.length === 0) continue
    fields.push(remainder)
    const start = toVttTimestamp(fields[format.indexOf('start')] || '')
    const end = toVttTimestamp(fields[format.indexOf('end')] || '')
    const text = fields[textIndex]
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, '\u00a0')
      .trim()
    if (!start || !end || !text) continue
    cues.push(`${start} --> ${end}\n${text}`)
  }
  if (cues.length === 0) throw new Error('This ASS/SSA subtitle has no supported dialogue cues.')
  return `WEBVTT\n\n${cues.join('\n\n')}`
}

/** Convert common external SRT/ASS/SSA files into browser-native WebVTT. */
export function subtitleToVtt(input: string): string {
  const clean = input.replace(/^\uFEFF/, '')
  if (/^\s*WEBVTT(?:\s|$)/i.test(clean)) return clean.replace(/\r/g, '')
  if (/^\s*\[Script Info\]/im.test(clean) && /^\s*\[Events\]/im.test(clean)) return convertAss(clean)
  if (/\d{1,2}:\d{2}:\d{2},\d{1,3}\s+-->\s+\d{1,2}:\d{2}:\d{2},\d{1,3}/.test(clean)) return convertSrt(clean)
  throw new Error('This subtitle format cannot be rendered by the browser player.')
}
