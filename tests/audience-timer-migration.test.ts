import { beforeEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ saved: {} as Record<string, unknown>, values: {} as Record<string, unknown> }))
vi.mock('electron', () => ({ BrowserWindow: class {}, screen: {} }))
vi.mock('electron-store', () => ({ default: class {
  constructor(options: { defaults: Record<string, unknown> }) { fixture.values = { ...options.defaults, ...fixture.saved } }
  get(key: string) { return fixture.values[key] }
  set(key: string, value: unknown) { fixture.values[key] = value }
} }))
beforeEach(() => { vi.resetModules(); fixture.saved = {} })
describe('pre-hall timer preference migration', () => {
  it('moves old enabled cues when no hall configuration existed at all', async () => {
    fixture.saved = { timerTickEnabled: true, timerGongEnabled: true, timerLoop: true }
    const { getAudienceTimer } = await import('../src/main/display-mapping')
    expect(getAudienceTimer()).toMatchObject({ tickEnabled: true, gongEnabled: true, loop: true })
    expect(fixture.values.audienceTimer).toMatchObject({ loop: true })
  })
  it('preserves explicit new hall switches instead of applying old preferences again', async () => {
    fixture.saved = { timerLoop: true, audienceTimer: { loop: false, tickEnabled: false, gongEnabled: false } }
    const { getAudienceTimer } = await import('../src/main/display-mapping')
    expect(getAudienceTimer()).toMatchObject({ loop: false, tickEnabled: false, gongEnabled: false })
  })
})
