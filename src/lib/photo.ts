import { MAX_PHOTO_CHARS, isPhoto } from './ledger'

/** Shrinks a chosen picture to a small square JPEG (centre-cropped) so it stays tiny in storage and in backups. */
export async function fileToAvatar(file: File, size = 192): Promise<string> {
  if (!/^image\/(jpeg|png|webp|heic|heif|gif|bmp)$/i.test(file.type) && !file.type.startsWith('image/')) throw new Error('Choose an image file.')
  if (file.size > 15_000_000) throw new Error('That picture is too large. Choose one under 15 MB.')
  const bmp = await createBitmap(file)
  const side = Math.min(bmp.w, bmp.h)
  const canvas = document.createElement('canvas')
  canvas.width = size; canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Your browser cannot process pictures.')
  ctx.fillStyle = '#1b1b1d'; ctx.fillRect(0, 0, size, size)
  ctx.drawImage(bmp.src, (bmp.w - side) / 2, (bmp.h - side) / 2, side, side, 0, 0, size, size)
  bmp.close()
  for (const q of [0.78, 0.66, 0.52, 0.4]) {
    const url = canvas.toDataURL('image/jpeg', q)
    if (isPhoto(url)) return url
  }
  throw new Error(`That picture could not be shrunk below ${Math.round(MAX_PHOTO_CHARS / 1000)} KB.`)
}

async function createBitmap(file: File): Promise<{ src: CanvasImageSource; w: number; h: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const b = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return { src: b, w: b.width, h: b.height, close: () => b.close() }
    } catch { /* fall back to <img> */ }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That file is not a readable picture.')); i.src = url })
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, close: () => {} }
  } finally { URL.revokeObjectURL(url) }
}
