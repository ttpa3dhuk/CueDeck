import { timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import type { IncomingHttpHeaders } from 'node:http'

export const LOCAL_HOSTS = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

/** Trust the socket peer, never Host/X-Forwarded-For supplied by the client. */
export function isLoopback(address: string | undefined): boolean {
  if (address === '::1') return true
  const v4 = address?.replace(/^::ffff:/i, '') ?? ''
  return isIP(v4) === 4 && v4.startsWith('127.')
}

function browserOriginAllowed(headers: IncomingHttpHeaders): boolean {
  const site = headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return false
  const source = headers.origin ?? headers.referer
  if (!source) return true // Native controllers do not send browser headers.
  if (typeof source !== 'string' || !headers.host) return false
  try { return new URL(source).origin === new URL(`http://${headers.host}`).origin }
  catch { return false }
}

function matchesKey(value: string | null, key: string | null): boolean {
  if (!value || !key || !/^[a-f0-9]{64}$/.test(value) || !/^[a-f0-9]{64}$/.test(key)) return false
  return timingSafeEqual(Buffer.from(value), Buffer.from(key))
}

export function remoteHttpAccess(
  protectedNetwork: boolean,
  key: string | null,
  address: string | undefined,
  headers: IncomingHttpHeaders,
  url: URL,
): 401 | 403 | null {
  // Browser request provenance is independent of optional controller credentials.
  if (!browserOriginAllowed(headers)) return 403
  if (!protectedNetwork) return null
  if (isLoopback(address)) {
    return LOCAL_HOSTS.test(headers.host ?? '') ? null : 403
  }
  const authorization = headers.authorization
  const bearer = typeof authorization === 'string' ? /^Bearer ([a-f0-9]{64})$/i.exec(authorization)?.[1] ?? null : null
  const query = url.searchParams.getAll('key')
  // If a header was sent, do not silently fall back to a different URL credential.
  const supplied = authorization !== undefined ? bearer : query.length === 1 ? query[0] : null
  if (!matchesKey(supplied, key)) return 401
  return null
}
