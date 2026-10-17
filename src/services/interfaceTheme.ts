export type InterfaceTheme = 'default' | 'cinematic'
export const INTERFACE_THEME_KEY = 'aurales_interface_theme'

export function loadInterfaceTheme(_storage: Pick<Storage, 'getItem'> = localStorage): InterfaceTheme {
  return 'cinematic'
}

export function persistInterfaceTheme(_theme: InterfaceTheme, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(INTERFACE_THEME_KEY, 'cinematic')
}
