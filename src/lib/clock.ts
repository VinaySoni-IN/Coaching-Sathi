/* Class times are stored as a plain 12-hour label ("6:00 PM") because they are shown as text and pasted
   into WhatsApp messages. These helpers turn that label into the three picker values and back. */

export type Meridiem = 'AM' | 'PM'
export interface Clock { hour: number; minute: number; meridiem: Meridiem }

/** Half-hour steps: what a coaching class can actually start at. */
export const MINUTES = [0, 30] as const
export const HOURS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const

/** Reads "6:00 PM", "6 pm", "18:30", "9.30am" … Returns null when there is no readable time. */
export function parseClock(value: string | undefined | null): Clock | null {
  if (typeof value !== 'string') return null
  const m = value.trim().match(/^(\d{1,2})[:.\s]?(\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?$/i)
  if (!m) return null
  let hour = Number(m[1])
  const minute = m[2] === undefined ? 0 : Number(m[2])
  const suffix = m[3]?.replace(/\./g, '').toLowerCase()
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return null
  let meridiem: Meridiem
  if (suffix) {
    meridiem = suffix === 'am' ? 'AM' : 'PM'
    if (hour > 12) return null
    if (hour === 0) hour = 12
  } else if (hour > 12) {
    // 24-hour clock
    meridiem = hour >= 12 ? 'PM' : 'AM'
    hour = hour % 12 === 0 ? 12 : hour % 12
  } else {
    meridiem = hour >= 12 ? 'PM' : 'AM'
    hour = hour % 12 === 0 ? 12 : hour
  }
  if (hour < 1 || hour > 12) return null
  // Snap to the nearest half hour so a hand-typed 5:45 still works with the picker.
  const snapped = minute < 45 ? (minute < 15 ? 0 : 30) : 0
  if (minute >= 45) {
    // Rounding up can cross noon/midnight, so carry into the hour and flip when needed.
    if (hour === 11) {
      hour = 12
      meridiem = meridiem === 'AM' ? 'PM' : 'AM'
    } else if (hour === 12) {
      hour = 1
    } else {
      hour += 1
    }
  }
  return { hour, minute: snapped, meridiem }
}

/** "6:00 PM" — the format the rest of the app expects. */
export function formatClock(c: Clock): string {
  const hour = c.hour < 1 ? 12 : c.hour > 12 ? 12 : c.hour
  return `${hour}:${String(c.minute).padStart(2, '0')} ${c.meridiem}`
}

/** Draft values for the picker when the stored label cannot be read. */
export const DEFAULT_CLOCK: Clock = { hour: 5, minute: 0, meridiem: 'PM' }
