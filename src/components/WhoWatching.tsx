import { useEffect, useState } from 'react'
import { getProfiles, PROFILE_CHANGED_EVENT, setActiveProfile, type AuralesProfile } from '../services/profiles'
import ProfileAvatar from './profiles/ProfileAvatar'

export default function WhoWatching({ onComplete }: { onComplete: () => void }) {
  const [visible, setVisible] = useState(false)
  const [profiles, setProfiles] = useState(getProfiles)
  useEffect(() => { const frame = requestAnimationFrame(() => setVisible(true)); const refresh = () => setProfiles(getProfiles()); window.addEventListener(PROFILE_CHANGED_EVENT, refresh); return () => { cancelAnimationFrame(frame); window.removeEventListener(PROFILE_CHANGED_EVENT, refresh) } }, [])
  const select = async (profile: AuralesProfile) => { if (await setActiveProfile(profile.id)) { setVisible(false); window.setTimeout(onComplete, 180) } }
  return <div className={`fixed inset-0 z-[10060] grid place-items-center bg-black p-6 transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`}><div className={`w-full max-w-3xl text-center transition duration-300 ${visible ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-3 scale-[.98] opacity-0'}`}><p className="text-xs font-bold uppercase tracking-[.28em] text-white/40">Aurales</p><h1 className="mt-3 text-4xl font-black tracking-tight text-white sm:text-5xl">Who’s watching?</h1><p className="mt-3 text-white/55">Choose a profile to load its Home, library, and preferences.</p><div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">{profiles.map((profile) => <button key={profile.id} onClick={() => select(profile)} className="group rounded-3xl border border-white/[.1] bg-white/[.035] p-6 text-center transition hover:-translate-y-1 hover:border-white/35 hover:bg-white/[.09]"><ProfileAvatar {...profile} size="lg" className="mx-auto transition group-hover:scale-105" /><p className="mt-5 text-lg font-bold text-white">{profile.name}</p><p className="mt-1 text-xs text-white/45">Select profile</p></button>)}</div></div></div>
}
