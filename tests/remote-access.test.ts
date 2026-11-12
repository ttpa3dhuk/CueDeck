import { describe, expect, it } from 'vitest'
import { isLoopback, remoteHttpAccess } from '../src/main/remote/access'
import { sanitizeSettings } from '../src/main/profile-core'

const key = 'a'.repeat(64)
const network = '192.0.2.10'
const url = new URL('http://192.0.2.20:9420/api/timer/start')
const host = '192.0.2.20:9420'

describe('optional network access key', () => {
  it.each([{ origin: 'https://attacker.example' }, { referer: 'https://attacker.example/page' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }])('rejects foreign browser origins with protection disabled: %j', headers => {
    expect(remoteHttpAccess(false, null, network, { host, ...headers }, url)).toBe(403)
  })
  it('allows same-origin browser requests with the optional key disabled', () => {
    expect(remoteHttpAccess(false, null, network, { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }, url)).toBeNull()
  })
  it('preserves requests without credentials when protection is off', () => {
    expect(remoteHttpAccess(false, null, network, { host }, url)).toBeNull()
  })
  it.each([undefined, 'Bearer wrong', `Bearer ${'b'.repeat(64)}`])('rejects missing or incorrect authorization %s', authorization => {
    expect(remoteHttpAccess(true, key, network, { host, authorization }, url)).toBe(401)
  })
  it('accepts the correct Bearer key and URL key for older HTTP controllers', () => {
    expect(remoteHttpAccess(true, key, network, { host, authorization: `Bearer ${key}` }, url)).toBeNull()
    expect(remoteHttpAccess(true, key, network, { host }, new URL(`${url}?key=${key}`))).toBeNull()
  })
  it('does not accept ambiguous credentials or fall back after a bad header', () => {
    expect(remoteHttpAccess(true, key, network, { host }, new URL(`${url}?key=${key}&key=bad`))).toBe(401)
    expect(remoteHttpAccess(true, key, network, { host, authorization: 'Bearer bad' }, new URL(`${url}?key=${key}`))).toBe(401)
  })
  it('fails closed when the stored key cannot be loaded', () => {
    expect(remoteHttpAccess(true, null, network, { host, authorization: `Bearer ${key}` }, url)).toBe(401)
  })
  it('ignores forged proxy and host headers when identifying the peer', () => {
    expect(remoteHttpAccess(true, key, network, { host: '127.0.0.1:9420', 'x-forwarded-for': '127.0.0.1' }, url)).toBe(401)
  })
  it.each(['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1'])('keeps local controllers working at %s', address => {
    expect(isLoopback(address)).toBe(true)
    expect(remoteHttpAccess(true, key, address, { host: '127.0.0.1:9420' }, url)).toBeNull()
  })
  it.each([undefined, '', '127.example.com', '192.0.2.10', '::ffff:192.0.2.10'])('does not trust non-loopback peer %s', address => {
    expect(isLoopback(address)).toBe(false)
  })
  it('rejects rebinding and browser cross-origin requests on local bypass', () => {
    expect(remoteHttpAccess(true, key, '127.0.0.1', { host: 'attacker.example:9420' }, url)).toBe(403)
    for (const headers of [{ origin: 'https://attacker.example' }, { referer: 'https://attacker.example/page' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
      expect(remoteHttpAccess(true, key, '127.0.0.1', { host: 'localhost:9420', ...headers }, url)).toBe(403)
    }
  })
  it('allows same-origin status polling and direct local navigation', () => {
    expect(remoteHttpAccess(true, key, '127.0.0.1', { host: 'localhost:9420', origin: 'http://localhost:9420', 'sec-fetch-site': 'same-origin' }, url)).toBeNull()
    expect(remoteHttpAccess(true, key, '::1', { host: '[::1]:9420', 'sec-fetch-site': 'none' }, url)).toBeNull()
  })
  it('does not import protection or credentials from a venue profile', () => {
    const remote = sanitizeSettings({ remote: { networkAuth: false, accessKey: key, key, enabled: true } }).remote
    expect(remote).not.toHaveProperty('networkAuth')
    expect(JSON.stringify(remote)).not.toContain(key)
  })
})
