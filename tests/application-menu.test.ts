import { beforeEach, expect, it, vi } from 'vitest'
const data=vi.hoisted(()=>({windows:[] as any[],set:vi.fn()}))
vi.mock('electron',()=>({BrowserWindow:{getAllWindows:()=>data.windows},Menu:{setApplicationMenu:data.set}}))
import { setOperatorApplicationMenu } from '../src/main/application-menu'
beforeEach(()=>{data.windows=[];data.set.mockReset()})
it('removes reattached output menus on every Windows application-menu update, preserving the operator',()=>{
 const operator={isDestroyed:()=>false,removeMenu:vi.fn()}
 const audience={isDestroyed:()=>false,removeMenu:vi.fn()}
 const speaker={isDestroyed:()=>false,removeMenu:vi.fn()}
 data.windows=[operator,audience,speaker]
 setOperatorApplicationMenu({} as any,operator as any,'win32')
 setOperatorApplicationMenu({} as any,operator as any,'win32')
 expect(data.set).toHaveBeenCalledTimes(2)
 expect(operator.removeMenu).not.toHaveBeenCalled()
 expect(audience.removeMenu).toHaveBeenCalledTimes(2)
 expect(speaker.removeMenu).toHaveBeenCalledTimes(2)
 expect(data.set.mock.invocationCallOrder[0]).toBeLessThan(audience.removeMenu.mock.invocationCallOrder[0])
})
it('leaves the macOS global menu alone and ignores destroyed output windows',()=>{
 const window={isDestroyed:()=>false,removeMenu:vi.fn()}
 const dead={isDestroyed:()=>true,removeMenu:vi.fn()}
 data.windows=[window,dead]
 setOperatorApplicationMenu({} as any,undefined,'darwin')
 expect(window.removeMenu).not.toHaveBeenCalled()
 setOperatorApplicationMenu({} as any,undefined,'win32')
 expect(window.removeMenu).toHaveBeenCalledOnce()
 expect(dead.removeMenu).not.toHaveBeenCalled()
})
