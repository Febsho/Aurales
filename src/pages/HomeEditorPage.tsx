import { useState } from 'react'
import { useAppStore } from '../stores/appStore'
import type { HomeRowConfig } from '../types'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

const LAYOUT_OPTIONS: { value: HomeRowConfig['layout']; label: string }[] = [
  { value: 'hero', label: 'Featured Hero' },
  { value: 'poster', label: 'Poster Carousel' },
  { value: 'landscape', label: 'Landscape Carousel' },
  { value: 'list', label: 'Compact List' },
  { value: 'continue', label: 'Continue Watching' },
]

function SortableRow({ row, onUpdate, onRemove }: {
  row: HomeRowConfig
  onUpdate: (id: string, updates: Partial<HomeRowConfig>) => void
  onRemove: (id: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: row.id })
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(row.title)

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 p-3 bg-surface-elevated rounded-xl group"
    >
      <button
        {...attributes}
        {...listeners}
        className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center hover:bg-surface-hover cursor-grab text-muted"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path d="M4 8h16M4 16h16" />
        </svg>
      </button>

      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => { onUpdate(row.id, { title }); setEditing(false) }}
            onKeyDown={(e) => { if (e.key === 'Enter') { onUpdate(row.id, { title }); setEditing(false) } }}
            className="bg-surface px-2 py-1 rounded-lg text-sm w-full focus:outline-none focus:ring-1 focus:ring-accent/30"
            autoFocus
          />
        ) : (
          <button onClick={() => setEditing(true)} className="text-sm font-medium text-left truncate block w-full">
            {row.title}
          </button>
        )}
        {row.addonId && row.addonId !== 'com.example.mockaddon' && (
          <span className="text-[10px] text-muted px-1.5 py-0.5 bg-white/5 rounded mt-0.5 inline-block">
            {row.addonId} / {row.catalogId}
          </span>
        )}
      </div>

      <select
        value={row.layout}
        onChange={(e) => onUpdate(row.id, { layout: e.target.value as HomeRowConfig['layout'] })}
        className="bg-surface border border-border-subtle rounded-lg px-2 py-1 text-xs focus:outline-none"
      >
        {LAYOUT_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>

      <button
        onClick={() => onUpdate(row.id, { enabled: !row.enabled })}
        className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
          row.enabled ? 'text-accent bg-accent/10' : 'text-muted bg-surface'
        }`}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          {row.enabled ? (
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          ) : (
            <>
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </>
          )}
        </svg>
      </button>

      <button
        onClick={() => onRemove(row.id)}
        className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-red-400 hover:bg-red-500/10 transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  )
}

export default function HomeEditorPage() {
  const { homeRows, updateHomeRow, removeHomeRow, reorderHomeRows, addHomeRow, resetHomeRows, addons } = useAppStore()

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (over && active.id !== over.id) {
      const oldIndex = homeRows.findIndex((r) => r.id === active.id)
      const newIndex = homeRows.findIndex((r) => r.id === over.id)
      reorderHomeRows(arrayMove(homeRows, oldIndex, newIndex))
    }
  }

  const addonCatalogs = addons
    .filter((a) => a.enabled)
    .flatMap((addon) =>
      addon.manifest.catalogs.map((cat) => ({
        addonId: addon.manifest.id,
        addonName: addon.manifest.name,
        catalogId: cat.id,
        catalogName: cat.name || cat.id,
        catalogType: cat.type,
        addonUrl: addon.url,
      }))
    )

  const isAlreadyAdded = (addonId: string, catalogId: string) =>
    homeRows.some((r) => r.addonId === addonId && r.catalogId === catalogId)

  const handleAddCatalog = (cat: typeof addonCatalogs[0]) => {
    addHomeRow({
      title: `${cat.catalogName} (${cat.addonName})`,
      addonId: cat.addonId,
      catalogType: cat.catalogType,
      catalogId: cat.catalogId,
      layout: cat.catalogType === 'movie' ? 'poster' : 'landscape',
      enabled: true,
    })
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Home Screen Editor</h1>
        <div className="flex gap-2">
          <button
            onClick={() => addHomeRow({ title: 'New Row', layout: 'poster', enabled: true })}
            className="px-4 py-2 bg-accent hover:bg-accent-hover text-black font-medium rounded-xl text-sm transition-colors"
          >
            Add Row
          </button>
          <button
            onClick={resetHomeRows}
            className="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-xl text-sm transition-colors"
          >
            Reset Default
          </button>
        </div>
      </div>

      <p className="text-sm text-muted mb-4">
        Drag to reorder, click title to rename, toggle visibility, or change layout style.
      </p>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={homeRows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {homeRows
              .sort((a, b) => a.order - b.order)
              .map((row) => (
                <SortableRow
                  key={row.id}
                  row={row}
                  onUpdate={updateHomeRow}
                  onRemove={removeHomeRow}
                />
              ))}
          </div>
        </SortableContext>
      </DndContext>

      {homeRows.length === 0 && (
        <div className="text-center py-12 text-muted">
          No rows configured. Add some rows or reset to default.
        </div>
      )}

      {/* Addon Catalogs */}
      {addonCatalogs.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-purple-400" />
            Add Addon Catalogs
          </h2>
          <p className="text-sm text-muted mb-3">
            Add catalog rows from your installed addons to the home screen.
          </p>
          <div className="space-y-2">
            {addonCatalogs.map((cat) => {
              const added = isAlreadyAdded(cat.addonId, cat.catalogId)
              return (
                <div
                  key={`${cat.addonId}-${cat.catalogId}`}
                  className="flex items-center justify-between p-3 bg-surface-elevated rounded-xl"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{cat.catalogName}</div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-muted px-1.5 py-0.5 bg-white/5 rounded">{cat.addonName}</span>
                      <span className="text-[10px] text-muted px-1.5 py-0.5 bg-white/5 rounded">{cat.catalogType}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleAddCatalog(cat)}
                    disabled={added}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      added
                        ? 'bg-white/5 text-muted cursor-default'
                        : 'bg-accent hover:bg-accent-hover text-black'
                    }`}
                  >
                    {added ? 'Added' : 'Add to Home'}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {addons.length === 0 && (
        <div className="mt-8 p-4 bg-surface-elevated rounded-xl text-center">
          <p className="text-sm text-muted">No addons installed. Go to Settings to add addons and their catalogs will appear here.</p>
        </div>
      )}
    </div>
  )
}
