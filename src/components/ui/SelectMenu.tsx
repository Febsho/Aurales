import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

/**
 * A styled replacement for a native <select>.
 *
 * WebKitGTK renders native select popups with the host desktop's light
 * palette, so an OS menu would appear mid-app over Aurales' dark surfaces. The
 * app previously worked around that with a long block of `.settings-page
 * select { ... !important }` overrides, which could restyle the closed control
 * but never the popup itself.
 *
 * The props deliberately mirror the native element -- `value`, an `onChange`
 * receiving `{ target: { value } }`, and `<option>` children -- so replacing a
 * native select is a tag rename rather than a rewrite of its handler. Children
 * are read rather than required as an array, which means call sites that
 * `.map()` their options keep working unchanged.
 */

interface SelectMenuProps {
  value: string | number
  onChange: (event: { target: { value: string } }) => void
  children: ReactNode
  /** Applied to the trigger's wrapper, e.g. a width utility. */
  className?: string
  disabled?: boolean
  'aria-label'?: string
  id?: string
}

interface ParsedOption {
  value: string
  label: string
  disabled: boolean
}

function parseOptions(children: ReactNode): ParsedOption[] {
  const out: ParsedOption[] = []
  const walk = (nodes: ReactNode) => {
    Children.forEach(nodes, (child) => {
      if (!isValidElement(child)) return
      const props = child.props as Record<string, unknown>
      if (child.type === 'optgroup') {
        walk(props.children as ReactNode)
        return
      }
      if (child.type !== 'option') return
      const raw = props.children
      const label =
        typeof raw === 'string' || typeof raw === 'number'
          ? String(raw)
          : Array.isArray(raw)
            ? raw.filter((p) => typeof p === 'string' || typeof p === 'number').join('')
            : String(props.value ?? '')
      out.push({
        value: String(props.value ?? ''),
        label,
        disabled: Boolean(props.disabled),
      })
    })
  }
  walk(children)
  return out
}

export default function SelectMenu({
  value,
  onChange,
  children,
  className = '',
  disabled,
  'aria-label': ariaLabel,
  id,
}: SelectMenuProps) {
  const options = useMemo(() => parseOptions(children), [children])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [flipUp, setFlipUp] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const typeahead = useRef({ query: '', at: 0 })

  const selectedIndex = Math.max(
    options.findIndex((o) => o.value === String(value)),
    0,
  )
  const selected = options[selectedIndex]

  const commit = useCallback(
    (index: number) => {
      const option = options[index]
      if (!option || option.disabled) return
      onChange({ target: { value: option.value } })
      setOpen(false)
    },
    [onChange, options],
  )

  useEffect(() => {
    if (!open) return
    setActiveIndex(selectedIndex)
  }, [open, selectedIndex])

  // Open upward when the menu would otherwise run past the viewport bottom.
  // Settings rows sit in a scroll container, so a menu near the fold would
  // otherwise be clipped rather than merely overflowing.
  useLayoutEffect(() => {
    if (!open || !rootRef.current) return
    const trigger = rootRef.current.getBoundingClientRect()
    const estimated = Math.min(options.length * 42 + 12, 288)
    setFlipUp(trigger.bottom + estimated > window.innerHeight - 16 && trigger.top > estimated)
  }, [open, options.length])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  // Keep the highlighted row in view when navigating a long list by keyboard.
  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  const step = useCallback(
    (from: number, delta: number) => {
      if (options.length === 0) return from
      let next = from
      for (let i = 0; i < options.length; i++) {
        next = (next + delta + options.length) % options.length
        if (!options[next].disabled) return next
      }
      return from
    },
    [options],
  )

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return
    const { key } = event

    if (!open) {
      if (key === 'Enter' || key === ' ' || key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault()
        setOpen(true)
      }
      return
    }

    switch (key) {
      case 'Escape':
        event.preventDefault()
        setOpen(false)
        return
      case 'Tab':
        setOpen(false)
        return
      case 'ArrowDown':
        event.preventDefault()
        setActiveIndex((i) => step(i, 1))
        return
      case 'ArrowUp':
        event.preventDefault()
        setActiveIndex((i) => step(i, -1))
        return
      case 'Home':
        event.preventDefault()
        setActiveIndex(step(options.length - 1, 1))
        return
      case 'End':
        event.preventDefault()
        setActiveIndex(step(0, -1))
        return
      case 'Enter':
      case ' ':
        event.preventDefault()
        commit(activeIndex)
        return
      default:
        break
    }

    // Type-ahead, matching native select behaviour: typed characters within a
    // second accumulate into a prefix, and jump to the first option matching it.
    if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = event.timeStamp
      const state = typeahead.current
      state.query = now - state.at > 1000 ? key : state.query + key
      state.at = now
      const prefix = state.query.toLowerCase()
      const match = options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(prefix))
      if (match >= 0) setActiveIndex(match)
    }
  }

  return (
    <div ref={rootRef} className={`select-menu ${className}`}>
      <button
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={handleKeyDown}
        className="select-menu__trigger"
        data-open={open || undefined}
      >
        <span className="select-menu__value">{selected?.label ?? ''}</span>
        <svg
          className="select-menu__chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="m7 10 5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
          className="settings-select-menu select-menu__list"
          data-flip={flipUp || undefined}
        >
          {options.map((option, index) => {
            const isSelected = option.value === String(value)
            return (
              <button
                key={`${option.value}-${index}`}
                type="button"
                role="option"
                data-index={index}
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                onClick={() => commit(index)}
                onPointerEnter={() => setActiveIndex(index)}
                className="select-menu__option"
                data-active={index === activeIndex || undefined}
                data-selected={isSelected || undefined}
              >
                <span className="select-menu__option-label">{option.label}</span>
                <span className="select-menu__marker" aria-hidden="true" />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
