import { describe, expect, it } from 'vitest'
import { MirrorPolicy, type MirrorObservation } from '../src/shared/mirror-policy'
const normal: MirrorObservation={timeline:'play1',playing:true,paused:false,ended:false,visible:true,width:3840,height:2160,seeking:false,readyState:4,colorSafe:true,consumers:true}
describe('adaptive program sharing',()=>{
 it('keeps healthy playback native without an image-copy tax',()=>{
  const p=new MirrorPolicy()
  for(let t=0;t<10000;t+=50){p.frame(t);expect(p.observe(t,normal)).toBe(false)}
  expect(p.sharing).toBe(false)
 })
 it('promotes a sustained unfinished seek once and does not oscillate',()=>{
  const p=new MirrorPolicy();p.observe(0,normal);p.frame(100)
  expect(p.observe(2500,{...normal,seeking:true,readyState:1})).toBe(true)
  expect(p.sharing).toBe(true);expect(p.observe(5000,normal)).toBe(false);expect(p.sharing).toBe(true)
 })
 it('gives an intentional seek/start its own warmup interval',()=>{
  const p=new MirrorPolicy();p.observe(0,normal)
  const seek={...normal,timeline:'manual seek',seeking:true,readyState:1}
  expect(p.observe(5000,seek)).toBe(false)
  expect(p.observe(6500,seek)).toBe(false)
  expect(p.observe(7100,seek)).toBe(true)
 })
 it('does not promote pause, EOF, hidden output, HDR, a lone decoder or naturally sparse frames',()=>{
  for(const override of [{playing:false},{paused:true},{ended:true},{visible:false},{colorSafe:false},{consumers:false},{}]){
   const p=new MirrorPolicy();p.observe(0,normal)
   expect(p.observe(8000,{...normal,...override})).toBe(false)
  }
 })
 it('supports a forced diagnostic comparison without changing the default',()=>{
  expect(new MirrorPolicy(true).sharing).toBe(true);expect(new MirrorPolicy().sharing).toBe(false)
 })
})
