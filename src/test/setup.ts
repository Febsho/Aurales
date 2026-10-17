import { vi } from 'vitest'

// Node 25 exposes an incomplete localStorage global unless --localstorage-file
// is configured. Tests need deterministic Web Storage behavior across Node LTS.
const values = new Map<string, string>()
const storage = {
  get length() { return values.size },
  key: (index: number) => [...values.keys()][index] ?? null,
  getItem: (key: string) => values.get(String(key)) ?? null,
  setItem: (key: string, value: string) => { values.set(String(key), String(value)) },
  removeItem: (key: string) => { values.delete(String(key)) },
  clear: () => values.clear(),
}
vi.stubGlobal('localStorage', storage)
