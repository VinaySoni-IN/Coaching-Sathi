import { createContext, useContext } from 'react'
import { NO_RATE } from './attendance'
import type { Rate } from './attendance'

export const RatesContext = createContext<Map<string, Rate>>(new Map())
export const useRate = (sid: string): Rate => useContext(RatesContext).get(sid) ?? NO_RATE
