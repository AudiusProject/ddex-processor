import Hashids from 'hashids'

// hasher to decode / encode IDs
const hasher = new Hashids('azowernasdfoia', 5)

export function encodeId(id: number | string) {
  const num = parseInt(id as string) || id
  return hasher.encode(num as number)
}

export function decodeId(id: string) {
  return hasher.decode(id)[0] as number
}

export async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function lowerAscii(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function parseBool(b: string | undefined): boolean {
  if (!b) return false
  b = b.toLowerCase().trim()
  return b != '' && b != '0' && b != 'false'
}

export function omitEmpty(obj: any) {
  const entries = Object.entries(obj).filter(([, v]) => Boolean(v))
  return Object.fromEntries(entries)
}
