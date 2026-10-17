import { useState } from 'react'
import CreateRoomButton from '../components/watch-together/CreateRoomButton'
import JoinRoomModal from '../components/watch-together/JoinRoomModal'
import { useWatchTogetherStore } from '../stores/watchTogetherStore'
import { useAppStore } from '../stores/appStore'
import { CirclePlay, Copy, LogIn, RefreshCw } from 'lucide-react'

export default function WatchTogetherPage() {
  const [joinOpen, setJoinOpen] = useState(false)
  const currentRoom = useWatchTogetherStore((state) => state.currentRoom)
  const setRoomPanelOpen = useWatchTogetherStore((state) => state.setRoomPanelOpen)
  const usesTopNav = useAppStore((state) => state.navigationStyle === 'topbar')

  return (
    <div className={`watch-together-page min-h-full overflow-hidden px-6 pb-16 sm:px-10 lg:px-16 ${usesTopNav ? 'pt-32' : 'pt-20'}`}>
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -right-[12vw] -top-[30vh] h-[75vh] w-[75vw] rounded-full bg-accent/[.09] blur-[140px]" />
        <div className="absolute -bottom-[35vh] -left-[20vw] h-[70vh] w-[70vw] rounded-full bg-white/[.035] blur-[150px]" />
      </div>

      <main className="relative mx-auto max-w-6xl">
        <header className="max-w-3xl">
          <p className="mb-4 text-xs font-black uppercase tracking-[.42em] text-accent">Watch Together</p>
          <h1 className="text-4xl font-black leading-[1.02] tracking-[-.045em] text-white sm:text-6xl lg:text-7xl">Movie night, every screen.</h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-white/60 sm:text-lg">Everyone plays their own stream while Aurales keeps the room on the same moment. Start a room or enter a friend’s code.</p>
          <div className="mt-5 flex items-center gap-2 text-sm font-semibold text-white/60">
            <RefreshCw className="h-5 w-5 text-accent" strokeWidth={2.2} />
            Play, pause and seek stay synchronized across the room.
          </div>
        </header>

        <section className="mt-10 grid gap-4 lg:grid-cols-2" aria-label="Room actions">
          <CreateRoomButton variant="hero" />
          <button type="button" onClick={() => setJoinOpen(true)} className="group flex min-h-28 w-full items-center gap-5 rounded-3xl border border-white/10 bg-surface-elevated px-6 py-5 text-left text-white shadow-xl transition-all duration-300 hover:-translate-y-0.5 hover:border-white/25 hover:bg-white/[.08] focus-ring">
            <span className="grid h-14 w-14 flex-shrink-0 place-items-center rounded-2xl bg-white/[.07] text-white/75"><LogIn className="h-6 w-6" strokeWidth={2.1} /></span>
            <span className="min-w-0 flex-1"><strong className="block text-xl font-black">Join a room</strong><span className="mt-1 block text-sm text-white/60">Enter the invite code shared by your friend.</span></span>
            <svg className="h-6 w-6 text-white/60 transition-transform group-hover:translate-x-1 group-hover:text-white" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </section>

        {currentRoom && (
          <button type="button" onClick={() => setRoomPanelOpen(true)} className="mt-5 flex w-full items-center gap-4 rounded-2xl border border-accent/20 bg-accent/[.08] px-5 py-4 text-left transition hover:bg-accent/[.12] focus-ring">
            <span className="relative flex h-3 w-3"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" /><span className="relative inline-flex h-3 w-3 rounded-full bg-accent" /></span>
            <span className="flex-1"><strong className="block text-sm text-white">Room {currentRoom.code} is active</strong><span className="text-xs text-white/60">{currentRoom.participants.length} {currentRoom.participants.length === 1 ? 'person' : 'people'} connected</span></span>
            <span className="text-xs font-black uppercase tracking-wider text-accent">Open room</span>
          </button>
        )}

        <section className="mt-14 grid gap-8 border-t border-white/[.08] pt-10 md:grid-cols-3">
          <Step icon={<CirclePlay className="h-6 w-6" strokeWidth={2.1} />} number="01" title="Start" description="Create a room, then choose any movie or episode in Aurales." />
          <Step icon={<Copy className="h-6 w-6" strokeWidth={2.1} />} number="02" title="Share the code" description="Friends join from Aurales with the short room code." />
          <Step icon={<RefreshCw className="h-6 w-6" strokeWidth={2.1} />} number="03" title="Watch in sync" description="Every person uses their own source; room playback stays aligned." />
        </section>
      </main>

      <JoinRoomModal open={joinOpen} onClose={() => setJoinOpen(false)} />
    </div>
  )
}

function Step({ icon, number, title, description }: { icon: React.ReactNode; number: string; title: string; description: string }) {
  return <article className="flex gap-4"><span className="grid h-12 w-12 flex-shrink-0 place-items-center rounded-2xl bg-white/[.06] text-white/70">{icon}</span><div><span className="text-meta font-black tracking-[.2em] text-accent">{number}</span><h2 className="mt-1 text-lg font-black text-white">{title}</h2><p className="mt-1 text-sm leading-relaxed text-white/60">{description}</p></div></article>
}
