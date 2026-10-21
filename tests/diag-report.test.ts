import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inflateRawSync } from 'node:zlib'
const mock = vi.hoisted(() => ({root:'', selected:[] as string[], handlers:new Map<string,Function>(), sender:{send:()=>{}}, state: {
  notes:{1:'private note'}, preview:{notes:{},path:null,currentSlide:0}, stream:{settings:{}}, pdfPath:null,currentSlide:1,video:{playing:false},keyVisualPath:null,
}}))
vi.mock('electron', () => ({app:{getVersion:()=> 'test',getPath:()=>mock.root,getLocale:()=> 'en',isPackaged:false},BrowserWindow:{},dialog:{showOpenDialog:async()=>({canceled:false,filePaths:mock.selected})},ipcMain:{on:vi.fn(),handle:(name:string,fn:Function)=>mock.handlers.set(name,fn)},screen:{getPrimaryDisplay:()=>({id:1}),getAllDisplays:()=>[]},shell:{}}))
vi.mock('electron-log/main',()=>({default:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),transports:{file:{getFile:()=>({path:join(mock.root,'absent.log')})}}}}))
vi.mock('../src/main/display-mapping',()=>({dumpPrefs:()=>({}),getCleanExit:()=>true,setCleanExit:vi.fn()}))
vi.mock('../src/main/state',()=>({store:{get:()=>mock.state}}))
vi.mock('../src/main/windows',()=>({getActiveWindows:()=>[],getOperatorWindow:()=>({webContents:mock.sender})}))
import { buildReport, registerDiagIpc, markMoment } from '../src/main/diag'
function entries(zip:Buffer):Map<string,Buffer>{
  const result=new Map<string,Buffer>();let at=0
  while(zip.readUInt32LE(at)===0x04034b50){
    const size=zip.readUInt32LE(at+18),length=zip.readUInt16LE(at+26),extra=zip.readUInt16LE(at+28)
    const name=zip.subarray(at+30,at+30+length).toString('utf8'),start=at+30+length+extra
    result.set(name,inflateRawSync(zip.subarray(start,start+size)));at=start+size
  }
  expect(zip.readUInt32LE(at)).toBe(0x02014b50)
  return result
}
beforeEach(async()=>{mock.root=await mkdtemp(join(tmpdir(),'cuedeck-report-zip-'));mock.handlers.clear();registerDiagIpc()})
afterEach(async()=>{await rm(mock.root,{recursive:true,force:true})})
it('does not attach even selected files without consent; attaches exact bytes with the token',async()=>{
  const file=join(mock.root,'Доклад.pptx');await writeFile(file,'original presentation');mock.selected=[file]
  const choose=()=>mock.handlers.get('diag:choose-materials')!({sender:mock.sender})
  await choose()
  let result=await buildReport('without attachments');expect(result.ok).toBe(true)
  if(!result.ok)throw Error(result.error)
  let files=entries(await readFile(result.path))
  expect([...files.keys()].some(n=>n.startsWith('materials'))).toBe(false)
  expect(files.get('state.json')!.toString()).not.toContain('private note')
  const picked=await choose()
  markMoment('menu')
  result=await buildReport('with attachments',picked.selection.token);expect(result.ok).toBe(true)
  if(!result.ok)throw Error(result.error)
  files=entries(await readFile(result.path))
  expect(files.get('materials/1/Доклад.pptx')!.toString()).toBe('original presentation')
  expect(JSON.parse(files.get('materials.json')!.toString())[0].bytes).toBe(21)
  expect(JSON.parse(files.get('markers.json')!.toString())[0].context.slide).toBe(1)
})
it('does not accept renderer-supplied paths as attachment authorization',async()=>{
  const result=await buildReport('',join(mock.root,'anything'))
  expect(result.ok).toBe(false)
  // An error must release the in-progress guard.
  expect((await buildReport('retry without files')).ok).toBe(true)
})
