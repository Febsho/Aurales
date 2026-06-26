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
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
