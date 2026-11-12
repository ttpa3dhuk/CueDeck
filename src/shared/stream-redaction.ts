/** Secrets used only for diagnostic copies; never mutate connection settings. */
export function streamSecretValues(value: unknown): string[] {
  const destinations = (value as { destinations?: unknown[] } | null)?.destinations
  if (!Array.isArray(destinations)) return []
  const secrets = new Set<string>()
  const add = (s: unknown): void => {
    if (typeof s !== 'string' || !s) return
    secrets.add(s)
    secrets.add(encodeURIComponent(s))
    try { secrets.add(decodeURIComponent(s)) } catch { /* malformed escape */ }
  }
  for (const item of destinations) {
    if (!item || typeof item !== 'object') continue
    const d = item as { key?: string; url?: string }
    add(d.key)
    try {
      const url = new URL(d.url ?? '')
      if (!/^rtmps?:$/.test(url.protocol)) continue
      add(url.username); add(url.password)
      const segments = url.pathname.split('/').filter(Boolean)
      if (!d.key?.trim() && segments.length >= 2) {
        add(segments.at(-1)); add(segments.at(-1)! + url.search)
      }
      for (const [name, value] of url.searchParams) {
        if (/key|token|secret|pass|auth|sign/i.test(name)) add(value)
      }
    } catch { /* URL itself is still hidden by redactRtmpText */ }
  }
  return [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)
}

export function redactRtmpText(text: string, secrets: readonly string[] = []): string {
  let safe = text
  for (const secret of secrets) if (secret) safe = safe.split(secret).join('***')
  safe = safe.replace(/rtmps?%3a%2f%2f[^\s"'<>]+/gi, '[RTMP URL hidden]')
    .replace(/rtmps?:[^\s"'<>]+/gi, raw => {
      try { const url = new URL(raw.replace(/\\\//g, '/')); return `${url.protocol}//${url.host}/***` }
      catch { return '[RTMP URL hidden]' }
    })
  return safe
}

/** Sanitize nested status/log strings as well as the URL setting. */
export function redactStreamDiagnostic<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === 'string') return redactRtmpText(value, secrets) as T
  if (Array.isArray(value)) return value.map(item => redactStreamDiagnostic(item, secrets)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactStreamDiagnostic(v, secrets)])) as T
  }
  return value
}

export function redactStreamSettings<T>(value: T): T {
  const safe = redactStreamDiagnostic(value, streamSecretValues(value))
  const settings = safe as { destinations?: Array<Record<string, unknown>> } | null
  if (!settings || !Array.isArray(settings.destinations)) return safe
  return { ...settings, destinations: settings.destinations.map(d => ({ ...d, key: d.key ? '***' : '' })) } as T
}
