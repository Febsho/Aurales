import { cloneElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
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
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { HomeRowConfig } from '../../types'
import { HomeEditRowContext } from './HomeEditRowContext'
import type { HomeEditRowProps } from './HomeEditRowContext'

function SortableHomeRow({ row, onRemove, children }: HomeEditRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? 'none' : transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.8 : undefined,
  }
  const headerLeftControls = (
    <button
      {...attributes}
      {...listeners}
      className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-surface-hover cursor-grab text-muted active:cursor-grabbing flex-shrink-0"
      aria-label={`Move ${row.title}`}
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 8h16M4 16h16" />
      </svg>
    </button>
  )
  const headerRightControls = (
    <button
      onClick={(event) => { event.stopPropagation(); onRemove(row.id) }}
      className="w-8 h-8 rounded-lg flex items-center justify-center text-neutral-500 hover:text-red-400 hover:bg-red-500/10 transition-all cursor-pointer flex-shrink-0"
      title="Remove shelf"
      aria-label={`Remove ${row.title}`}
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v3M4 7h16" />
      </svg>
    </button>
  )

  return (
    <div ref={setNodeRef} style={style} className="border border-transparent hover:border-border-subtle/20 rounded-2xl py-1 transition-colors relative">
      {cloneElement(children as ReactElement<Record<string, unknown>>, { headerLeftControls, headerRightControls })}
    </div>
  )
}

interface HomeEditListProps {
  rows: HomeRowConfig[]
  onReorder: (activeId: string, overId: string) => void
  children: ReactNode
}

export default function HomeEditList({ rows, onReorder, children }: HomeEditListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) onReorder(String(active.id), String(over.id))
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={rows.map((row) => row.id)} strategy={verticalListSortingStrategy}>
        <HomeEditRowContext.Provider value={SortableHomeRow}>{children}</HomeEditRowContext.Provider>
      </SortableContext>
    </DndContext>
  )
}
