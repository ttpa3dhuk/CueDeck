import { describe, expect, it } from 'vitest'
import { canMirrorColor } from '../src/shared/mirror-color'
describe('monitor bitmap color boundary', () => {
  it('allows ordinary SDR video', () => {
    expect(canMirrorColor({primaries:'bt709',transfer:'bt709'})).toBe(true)
    expect(canMirrorColor({primaries:'smpte170m',transfer:'smpte170m'})).toBe(true)
  })
  it('keeps HDR, wide gamut and unknown metadata on native rendering', () => {
    for(const color of [{primaries:'bt2020',transfer:'smpte2084'},{primaries:'bt2020',transfer:'arib-std-b67'},
      {primaries:'smpte432',transfer:'iec61966-2-1'},{primaries:'bt709',transfer:null},{}])expect(canMirrorColor(color)).toBe(false)
  })
})
