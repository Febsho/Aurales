import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { completeSimklBrowserCallback } from '../services/simkl/auth'
import { useAppStore } from '../stores/appStore'

export default function SimklCallbackPage() {
  const [message, setMessage] = useState('Finishing Simkl connection…')
  const callbackRequest = useRef<Promise<Awaited<ReturnType<typeof completeSimklBrowserCallback>>> | null>(null)
  const setSimklConnected = useAppStore((state) => state.setSimklConnected)
  const setSimklAccount = useAppStore((state) => state.setSimklAccount)

  useEffect(() => {
    if (!callbackRequest.current) {
      const search = window.location.search
      window.history.replaceState(null, '', window.location.pathname)
      callbackRequest.current = completeSimklBrowserCallback(search)
    }
    let active = true
    void callbackRequest.current.then((account) => {
      if (!active) return
      setSimklAccount(account)
      setSimklConnected(true)
      setMessage(`Connected as ${account.username}.`)
    }).catch((error: unknown) => {
      if (active) setMessage(error instanceof Error ? error.message : 'Could not finish Simkl connection.')
    })
    return () => { active = false }
  }, [setSimklAccount, setSimklConnected])

  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-6 text-center">
      <div className="text-accent font-black text-3xl mb-4">A</div>
      <p role="status" className="max-w-md text-white/80">{message}</p>
      {message !== 'Finishing Simkl connection…' && <Link className="mt-6 rounded-xl bg-accent px-5 py-3 font-semibold text-black" to="/settings">Return to Aurales</Link>}
    </main>
  )
}
