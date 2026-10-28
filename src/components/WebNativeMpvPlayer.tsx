import type { ComponentType } from 'react'

/** The native player is excluded from browser bundles; StreamSelector uses InAppPlayer there. */
const WebNativeMpvPlayer: ComponentType<Record<string, unknown>> = () => null
export default WebNativeMpvPlayer
