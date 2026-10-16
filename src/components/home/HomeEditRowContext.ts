import { createContext } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { HomeRowConfig } from '../../types'

export interface HomeEditRowProps {
  row: HomeRowConfig
  onRemove: (id: string) => void
  children: ReactNode
}

export const HomeEditRowContext = createContext<ComponentType<HomeEditRowProps> | null>(null)
