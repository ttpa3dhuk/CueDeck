import { expect, it } from 'vitest'
import { DEFAULT_MATERIAL_SETTINGS, materialTakeTimer, sanitizeMaterialSettings, validMaterialDuration } from '../src/shared/material-settings'
it('starts new installs and older settings at zero without enabling automatic timers',()=>{
 expect(sanitizeMaterialSettings(undefined)).toEqual({defaultDurationMs:0,autoStartTimer:false})
 expect(DEFAULT_MATERIAL_SETTINGS).toEqual({defaultDurationMs:0,autoStartTimer:false})
 expect(sanitizeMaterialSettings({defaultDurationMs:900000,autoStartTimer:true})).toEqual({defaultDurationMs:900000,autoStartTimer:true})
})
it('rejects non-finite, fractional and out-of-range durations',()=>{
 for(const value of [NaN,Infinity,-1,0.5,999*60000+1,'15000',null])expect(validMaterialDuration(value)).toBe(false)
 expect(validMaterialDuration(0)).toBe(true)
 expect(validMaterialDuration(999*60000)).toBe(true)
})
it('starts a fresh presentation countdown only when explicitly enabled with a positive duration',()=>{
 for(const kind of ['pdf','pptx'] as const){
  expect(materialTakeTimer(900000,kind,'countdown',true,123)).toEqual({durationMs:900000,startedAt:123,elapsedMs:0,running:true,cycles:0})
  expect(materialTakeTimer(900000,kind,'countdown',false,123).running).toBe(false)
  expect(materialTakeTimer(0,kind,'countdown',true,123).running).toBe(false)
  expect(materialTakeTimer(900000,kind,'stopwatch',true,123).running).toBe(false)
 }
 for(const kind of ['image','video','live',null] as const)expect(materialTakeTimer(900000,kind,'countdown',true,123).running).toBe(false)
})
