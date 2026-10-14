import { describe, expect, it } from 'vitest'
import { makeLiveUri, parseLiveUri, liveDisplayName } from '../src/shared/live'
import { validOmtAddress } from '../src/shared/omt-input'

describe('network source identity', () => {
  it('round trips a discovered source and its audio preference through saved projects', () => {
    for (const audioLabel of [null, 'SHUTTLE (CueDeck Зал & видео?)']) {
      const source = { kind: 'omt' as const, omtAddress: 'SHUTTLE (CueDeck Зал & видео?)', videoLabel: 'SHUTTLE (CueDeck Зал & видео?)', audioLabel }
      const path = JSON.parse(JSON.stringify(makeLiveUri(source)))
      expect(parseLiveUri(path)).toEqual(source)
      expect(liveDisplayName(path)).toBe(source.videoLabel)
    }
  })
  it('accepts explicit hostname, IPv4 and IPv6 endpoints without allowing credentials or URL parameters', () => {
    for (const address of ['omt://localhost:6400', 'omt://192.168.1.100:6400', 'omt://[::1]:6400', 'MAC (Timer)']) expect(validOmtAddress(address)).toBe(true)
    for (const address of ['', 'http://localhost:6400', 'omt://localhost', 'omt://localhost:0', 'omt://localhost:65536', 'omt://user@localhost:6400', 'omt://localhost:6400?x=1', 'MAC (Timer)\0', 'MAC (Timer)\n', 'x'.repeat(1024)]) expect(validOmtAddress(address)).toBe(false)
  })
  it('rejects invalid network URIs before they can be reopened', () => {
    expect(parseLiveUri('live://omt?v=Test&address=http%3A%2F%2Flocalhost%3A6400')).toBeNull()
    expect(() => makeLiveUri({ kind: 'omt', videoLabel: 'Test', omtAddress: '', audioLabel: null })).toThrow()
    expect(parseLiveUri(makeLiveUri({ videoLabel: 'Camera', audioLabel: 'Mic' }))).toEqual({ videoLabel: 'Camera', audioLabel: 'Mic' })
  })
})
