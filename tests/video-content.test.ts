import { describe, expect, it, vi } from 'vitest'
import { rejectAudioOnlyVideo } from '../src/renderer/shared/video-content'
function media(overrides: object = {}) {
  const el=Object.assign(new EventTarget(), { getAttribute: ()=>'clip.mov',srcObject:null,readyState:2,videoWidth:0,videoHeight:0,pause:vi.fn() },overrides)
  const report=vi.fn(),error=vi.fn();el.addEventListener('error',error)
  rejectAudioOnlyVideo(el as unknown as HTMLVideoElement,report)
  el.dispatchEvent(new Event('loadeddata'));return {el,report,error}
}
describe('video container with an undecodable picture', () => {
  it('stops audio-only success and uses the existing video-error path', () => {
    const {el,report,error}=media();expect(el.pause).toHaveBeenCalledOnce();expect(report).toHaveBeenCalledOnce();expect(error).toHaveBeenCalledOnce()
  })
  it('keeps a real video and does not classify an unfinished load', () => {
    expect(media({videoWidth:1920,videoHeight:1080}).error).not.toHaveBeenCalled()
    expect(media({readyState:1}).error).not.toHaveBeenCalled()
  })
  it('does not reject live streams or shared-canvas monitor placeholders', () => {
    expect(media({srcObject:{}}).error).not.toHaveBeenCalled()
    expect(media({getAttribute:()=>null}).error).not.toHaveBeenCalled()
  })
})
