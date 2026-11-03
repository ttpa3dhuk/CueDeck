import { expect, it } from 'vitest'
import { UpdateActions } from '../companion-module/src/actions'
import { UpdateFeedbacks } from '../companion-module/src/feedbacks'
import { UpdatePresets } from '../companion-module/src/presets'
import { variableValues, type CueDeckState } from '../companion-module/src/state'

it.each(['ru','en'] as const)('new output/project/TAKE presets dispatch registered actions (%s)', async lang => {
  let actions: any, feedbacks: any, presets: any, sections: any
  const calls: any[]=[]
  const self: any={label:'cuedeck',state:null,presetLang:()=>lang,sendCommand:async(c:any)=>calls.push(c),
    setActionDefinitions:(v:any)=>actions=v,setFeedbackDefinitions:(v:any)=>feedbacks=v,setPresetDefinitions:(s:any,v:any)=>{sections=s;presets=v}}
  UpdateActions(self);UpdateFeedbacks(self);UpdatePresets(self)
  const ids=sections.filter((s:any)=>['outputs_project','take_modes','video'].includes(s.id)).flatMap((s:any)=>s.definitions)
  expect(ids).toContain('video_loop')
  for(const id of ids){
    const p=presets[id];expect(p,id).toBeDefined()
    for(const a of p.steps.flatMap((s:any)=>s.down)) {expect(actions[a.actionId],id).toBeDefined();await actions[a.actionId].callback(a)}
    for(const f of p.feedbacks)expect(feedbacks[f.feedbackId],id).toBeDefined()
  }
  expect(calls).toContainEqual({path:'project/save'})
  expect(calls).toContainEqual({path:'syphon/on'})
  expect(calls).toContainEqual({path:'audience-output/toggle'})
  expect(calls).toContainEqual({path:'test-screen/toggle'})
  expect(calls).toContainEqual({path:'take/fade'})
})

it('output feedback uses actual GPU state, not just the request, and clears offline',()=>{
  let feedbacks:any
  const self:any={state:{outputs:{audience:true,testScreen:false,syphon:{enabled:true,state:'blocked'}},project:{saved:true},omt:{timer:{on:true},prompter:{on:false}}},setFeedbackDefinitions:(v:any)=>feedbacks=v}
  UpdateFeedbacks(self)
  expect(feedbacks.output_active.callback({options:{target:'syphon'}})).toBe(false)
  expect(feedbacks.syphon_warning.callback()).toBe(true)
  self.state.outputs.syphon.state='on'
  expect(feedbacks.output_active.callback({options:{target:'syphon'}})).toBe(true)
  expect(feedbacks.syphon_warning.callback()).toBe(false)
  expect(feedbacks.omt_output_on.callback({options:{target:'timer'}})).toBe(true)
  expect(feedbacks.project_named.callback()).toBe(true)
  self.state=null
  expect(feedbacks.output_active.callback({options:{target:'audience'}})).toBe(false)
  expect(feedbacks.omt_output_on.callback({options:{target:'timer'}})).toBe(false)
  expect(feedbacks.project_named.callback()).toBe(false)
  expect(variableValues(null)).toMatchObject({audience_output:false,test_screen:false,syphon_enabled:false,project_saved:false,omt_timer_on:false,omt_prompter_on:false,syphon_state:''})
})
