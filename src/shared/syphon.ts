import { SYPHON_NAME_MAX } from './types.js'

/** Syphon source name: printable, no control characters, 1–64 chars. */
export function cleanSyphonName(v: unknown, def: string): string {
  if (typeof v !== 'string') return def
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, SYPHON_NAME_MAX)
  return s || def
}
