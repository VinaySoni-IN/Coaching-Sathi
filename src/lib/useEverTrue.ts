import { useState } from 'react'

/** Becomes true the first time `v` is true and stays true: used to mount a lazily-loaded sheet only once it is first opened. */
export function useEverTrue(v: boolean): boolean {
  const [seen, setSeen] = useState(v)
  if (v && !seen) setSeen(true)
  return seen || v
}
