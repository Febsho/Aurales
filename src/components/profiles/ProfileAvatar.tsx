import { useState } from 'react'
import { cachedImage, retryImageFromSource } from '../../services/imageCache'
import { getProfileAvatar, type ProfileAvatarRef } from '../../data/profileAvatars'

type Props = { name: string; accent?: string; avatar?: string; avatarRef?: ProfileAvatarRef; size?: 'sm' | 'md' | 'lg'; className?: string }
const sizes = { sm: 'h-6 w-6 text-xs rounded-md', md: 'h-12 w-12 text-xl rounded-[28%]', lg: 'h-20 w-20 text-3xl rounded-[28%]' }
export default function ProfileAvatar({ name, accent = '#8b5cf6', avatar, avatarRef, size = 'md', className = '' }: Props) {
  const [failed, setFailed] = useState(false)
  const selected = getProfileAvatar(avatarRef)
  const fallback = avatar || name[0]?.toUpperCase() || '?'
  if (!selected || failed) return <span aria-label={`${name} avatar`} className={`${sizes[size]} grid shrink-0 place-items-center font-black text-white shadow-lg ${className}`} style={{ background: `linear-gradient(145deg, ${accent}, #151515)` }}>{fallback}</span>
  const source = selected.imageUrl
  return <span title={`${selected.name} — ${selected.show}`} className={`${sizes[size]} block shrink-0 overflow-hidden bg-white/10 shadow-lg ${className}`}><img src={cachedImage(source)} onError={(event) => { if (!retryImageFromSource(event.currentTarget, source)) setFailed(true) }} alt={`${selected.name} from ${selected.show}`} loading="lazy" decoding="async" className="h-full w-full object-cover" /></span>
}
