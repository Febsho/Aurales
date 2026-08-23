import { Component, type ReactNode } from 'react'

interface Props {
  fallback?: ReactNode
  label?: string
  children: ReactNode
}

interface State {
  hasError: boolean
  error?: Error
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error) {
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`, error)
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      return (
        <div className="px-6 py-4">
          <div className="rounded-xl border border-dashed border-red-500/20 bg-red-500/5 p-4 text-center">
            <p className="text-xs text-red-400/70">
              {this.props.label ? `"${this.props.label}" failed to load` : 'Something went wrong'}
            </p>
            {this.state.error?.message && (
              <p className="mx-auto mt-2 max-w-3xl break-words text-label text-red-300/55">
                {this.state.error.message}
              </p>
            )}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-3 rounded-full border border-red-400/20 bg-red-400/10 px-3 py-1.5 text-xs font-semibold text-red-200/80 hover:bg-red-400/15"
            >
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
