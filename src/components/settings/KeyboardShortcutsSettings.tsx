import { KEYBOARD_SHORTCUT_SECTIONS } from '../../services/keyboardShortcuts'

export default function KeyboardShortcutsSettings() {
  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-accent/15 bg-accent/[0.06] px-5 py-4">
        <p className="text-sm font-semibold text-white">Shortcuts work across Classic and Cinematic layouts.</p>
        <p className="mt-1 text-xs leading-relaxed text-white/40">They are paused while you type in an input, text area, or editable field.</p>
      </div>

      {KEYBOARD_SHORTCUT_SECTIONS.map((section) => (
        <section key={section.title} className="overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.03]">
          <div className="border-b border-white/[0.05] px-6 py-4">
            <h3 className="text-[15px] font-semibold text-white">{section.title}</h3>
          </div>
          <div className="divide-y divide-white/[0.04]">
            {section.shortcuts.map((shortcut) => (
              <div key={shortcut.label} className="flex items-center justify-between gap-6 px-6 py-4">
                <div className="min-w-0">
                  <p className="text-sm text-white/85">{shortcut.label}</p>
                  {shortcut.description && <p className="mt-0.5 text-xs leading-relaxed text-white/35">{shortcut.description}</p>}
                </div>
                <div className="flex flex-shrink-0 flex-wrap justify-end gap-1.5">
                  {shortcut.keys.map((key) => (
                    <kbd key={key} className="min-w-8 rounded-lg border border-white/[0.1] bg-black/30 px-2.5 py-1.5 text-center text-xs font-bold text-white/65 shadow-inner">
                      {key}
                    </kbd>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
