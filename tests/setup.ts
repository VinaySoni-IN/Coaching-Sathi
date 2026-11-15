// happy-dom's Web Animations implementation rejects when framer-motion cancels an animation.
// Removing it makes framer-motion fall back to its JS animator, which is what we want in tests.
if (typeof Element !== 'undefined') {
  // @ts-expect-error test-only shim
  delete Element.prototype.animate
}

// Every test talks to an in-memory Supabase stand-in instead of a live project.
import { beforeEach } from 'vitest'
import { installFakeCloud, resetFakeCloud } from './fakeCloud'

installFakeCloud()
beforeEach(() => { resetFakeCloud() })
