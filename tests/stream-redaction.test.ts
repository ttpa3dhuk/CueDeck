import { expect, it } from 'vitest'
import { redactRtmpText, redactStreamDiagnostic, redactStreamSettings, streamSecretValues } from '../src/shared/stream-redaction'

it('hides embedded keys, credentials and query tokens without changing live settings', () => {
  const settings = { destinations: [{ name: '', key: '', url: 'rtmps://user:secretpass@stream.example/live/EMBEDDED_KEY?token=QUERY_SECRET' },
    { name: 'second', key: 'EXPLICIT_KEY', url: 'rtmp://other.example/app' }] }
  const original = structuredClone(settings), secrets = streamSecretValues(settings)
  const redacted = JSON.stringify(redactStreamSettings(settings))
  for (const key of ['EMBEDDED_KEY', 'secretpass', 'QUERY_SECRET', 'EXPLICIT_KEY']) expect(redacted).not.toContain(key)
  expect(settings).toEqual(original)
  expect(redacted).toContain('stream.example')
  expect(redactRtmpText('Server rejected EXPLICIT_KEY and EMBEDDED_KEY', secrets)).not.toMatch(/EXPLICIT_KEY|EMBEDDED_KEY/)
})
it('scrubs older RTMP URLs without needing the current key', () => {
  for (const url of ['rtmp://old.example/live/OLD_SECRET', 'RTMPS://old.example/app/OLD_SECRET?sign=OLD_TOKEN',
    'rtmp:\\/\\/old.example/live/OLD_SECRET', 'rtmp%3A%2F%2Fold.example%2Flive%2FOLD_SECRET', 'rtmp:malformed/OLD_SECRET']) {
    expect(redactRtmpText('Failed '+url)).not.toMatch(/OLD_SECRET|OLD_TOKEN/)
  }
})
it('removes decoded and encoded keys from nested error and log copies', () => {
  const secrets = streamSecretValues({ destinations: [{ key: '', url: 'rtmps://host/live/secret%2Fvalue' }] })
  const source = { error: 'secret/value rejected', log: [{ text: 'secret%2Fvalue rejected' }], count: 3 }
  const safe = redactStreamDiagnostic(source, secrets)
  expect(JSON.stringify(safe)).not.toMatch(/secret|value/)
  expect(source.error).toContain('secret/value'); expect(safe.count).toBe(3)
})
