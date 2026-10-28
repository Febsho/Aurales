/** Browser build fallback for desktop IPC. Native-only features fail explicitly. */
export const isTauri = () => false
export const convertFileSrc = (path: string) => path
export async function invoke<T = unknown>(command: string): Promise<T> {
  throw new Error(`Aurales desktop feature "${command}" is unavailable in the browser.`)
}
