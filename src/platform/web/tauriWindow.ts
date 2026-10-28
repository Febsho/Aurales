const unsupported = async () => { throw new Error('Desktop window controls are unavailable in the browser.') }
export function getCurrentWindow() {
  return { innerSize: unsupported, outerPosition: unsupported, setFocus: unsupported, onMoved: unsupported, onResized: unsupported, setFullscreen: unsupported }
}
