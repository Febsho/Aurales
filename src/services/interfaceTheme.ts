export type InterfaceTheme = 'default' | 'cinematic'
export const INTERFACE_THEME_KEY = 'aurales_interface_theme'

export function loadInterfaceTheme(storage: Pick<Storage, 'getItem'> = localStorage): InterfaceTheme {
  return storage.getItem(INTERFACE_THEME_KEY) === 'cinematic' ? 'cinematic' : 'default'
}

export function persistInterfaceTheme(theme: InterfaceTheme, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(INTERFACE_THEME_KEY, theme)
}

