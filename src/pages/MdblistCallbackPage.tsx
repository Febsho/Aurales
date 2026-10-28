import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { completeMdblistBrowserCallback } from '../services/mdblist'

export default function MdblistCallbackPage() {
  const [message, setMessage] = useState('Finishing MDBList connection…')
  const callbackRequest = useRef<Promise<unknown> | null>(null)

  useEffect(() => {
    if (!callbackRequest.current) {
      const search = window.location.search
      window.history.replaceState(null, '', window.location.pathname)
      callbackRequest.current = completeMdblistBrowserCallback(search)
    }
    let active = true
    void callbackRequest.current.then(() => {
      if (active) setMessage('MDBList is connected to this browser.')
    }).catch((error: unknown) => {
      if (active) setMessage(error instanceof Error ? error.message : 'Could not finish MDBList connection.')
    })
    return () => { active = false }
  }, [])

  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-6 text-center">
      <div className="text-accent font-black text-3xl mb-4">A</div>
      <p role="status" className="max-w-md text-white/80">{message}</p>
      {message !== 'Finishing MDBList connection…' && <Link className="mt-6 rounded-xl bg-accent px-5 py-3 font-semibold text-black" to="/settings">Return to Aurales</Link>}
    </main>
  )
}
