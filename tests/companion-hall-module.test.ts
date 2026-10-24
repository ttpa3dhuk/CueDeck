import { describe, expect, it } from 'vitest'
import { UpdateActions } from '../companion-module/src/actions'
import { UpdateFeedbacks } from '../companion-module/src/feedbacks'
import { UpdatePresets } from '../companion-module/src/presets'
import { variableValues } from '../companion-module/src/state'
import { readFileSync } from 'node:fs'

describe('Companion hall controls', () => {
  it('every hall preset dispatches a supported action and its feedback changes with hall state', async () => {
    let actions: any, feedbacks: any, presets: any
    const calls: any[] = []
    const self: any = {label:'cuedeck', state:{audienceTimer:{running:false,visible:false,loop:false,tickEnabled:false,gongEnabled:false,color:'green'}},
      presetLang:()=> 'ru', setActionDefinitions:(v:any)=>actions=v, setFeedbackDefinitions:(v:any)=>feedbacks=v,
      setPresetDefinitions:(_s:any,v:any)=>presets=v, sendCommand:async(c:any)=>calls.push(c)}
    UpdateActions(self); UpdateFeedbacks(self); UpdatePresets(self)
    expect(Object.keys(presets).filter(id=>id.startsWith('audience_set_'))).toEqual(['audience_set_5'])
    expect(presets.audience_add_1.steps[0].down[0]).toMatchObject({actionId:'audience_timer_adjust',options:{direction:'add',amount:'1'}})
    expect(presets.audience_sub_1.steps[0].down[0]).toMatchObject({actionId:'audience_timer_adjust',options:{direction:'sub',amount:'1'}})
    for (const [id,p] of Object.entries<any>(presets).filter(([id])=>id.startsWith('audience_'))) {
      for (const a of p.steps.flatMap((step:any)=>step.down)) {
        expect(actions[a.actionId],id).toBeDefined()
        await actions[a.actionId].callback(a)
      }
      for (const f of p.feedbacks) expect(feedbacks[f.feedbackId],id).toBeDefined()
    }
    expect(calls.every(c=>c.path.startsWith('audience-timer/'))).toBe(true)
    const flag=feedbacks.audience_timer_flag
    expect(flag.callback({options:{setting:'visible'}})).toBe(false)
    self.state.audienceTimer.visible=true
    expect(flag.callback({options:{setting:'visible'}})).toBe(true)
    self.state=null
    expect(flag.callback({options:{setting:'visible'}})).toBe(false)
    expect(variableValues(null).audience_timer_running).toBe(false)
  })
  it('hall page uses separate hall feedback variables', () => {
    for(const file of ['CueDeck.companionconfig','CueDeck.en.companionconfig']) {
      const cfg=JSON.parse(readFileSync(new URL('../companion/'+file,import.meta.url),'utf8'))
      const page=Object.values<any>(cfg.pages).find(p=>p.id==='cuedeckHallTimer')
      expect(page).toBeDefined()
      for(const row of Object.values<any>(page.controls)) for(const button of Object.values<any>(row)) {
        const expressions=JSON.stringify(button)
        expect(expressions).not.toContain('cuedeck_timer_running')
        const validate = (node: any): void => {
          if (!node || typeof node !== 'object') return
          if (node.isExpression && typeof node.value === 'string') {
            const expression = node.value.replace(/\$\([^)]+\)/g, '1')
            expect(() => new Function('return (' + expression + ')')).not.toThrow()
          }
          for (const value of Object.values(node)) validate(value)
        }
        validate(button)
      }
    }
  })
})
