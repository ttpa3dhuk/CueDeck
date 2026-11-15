"""Exercise built CueDeck UI through its public API; no PDF renderer substitutes.
Config/fixtures/results stay outside Git. Run shared and legacy in separate owned hosts.
"""
import argparse,base64,json,sys,time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'release-qa'))
from cdp import target
p=argparse.ArgumentParser();p.add_argument('config');a=p.parse_args()
config=json.loads(Path(a.config).read_text());out=Path(config['localOutput']);out.mkdir(parents=True,exist_ok=True)
port=config.get('cdpPort',12181); inspector=config.get('inspectorPort',12182)
roles=['operator','speaker','audience']; peers={};result={'mode':config['mode'],'cases':[],'samples':[],'pass':False}
def api(expr):return peers['operator'].evaluate(expr,timeout=120)
def state():return api('window.api.state.get()')
def settle():time.sleep(config.get('settleSeconds',.8))
def stats():return api('window.api.pdfFrames.stats()') if config['mode']=='shared' else None
def record(name,value):result['cases'].append({'name':name,'value':value});print(name,json.dumps(value,ensure_ascii=False)[:800],flush=True)
def save(): (out/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
def paint_snapshot(role,save_png=None):
 c=peers[role];cid='slide-canvas' if role=='audience' else 'current-canvas'
 value=c.evaluate("""(async()=>{const c=document.getElementById(%s);const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',d)),b=>b.toString(16).padStart(2,'0')).join('');
 return {width:c.width,height:c.height,hash,png:%s?c.toDataURL():null};})()"""%(json.dumps(cid),'true' if save_png else 'false'),timeout=120)
 if save_png:(out/save_png).write_bytes(base64.b64decode(value.pop('png').split(',')[1]))
 else:value.pop('png')
 return value
try:
 peers['operator']=target(port,'role=operator')
 display=api('window.api.displays.list()')[0]['id']
 api("window.api.layout.set('operator-speaker-audience',%s,true,false)"%json.dumps(dict.fromkeys(roles,display)))
 settle()
 for role in roles[1:]:peers[role]=target(port,'role='+role)
 for role,c in peers.items():
  cid='slide-canvas' if role=='audience' else 'current-canvas'
  c.evaluate("""globalThis.__qaPaints=[];globalThis.__qaCanvasId=%s;
  for(const name of ['drawImage','putImageData']){const old=CanvasRenderingContext2D.prototype[name];CanvasRenderingContext2D.prototype[name]=function(...args){const r=old.apply(this,args);if(this.canvas.id===__qaCanvasId){__qaPaints.push(performance.now());if(__qaPaints.length>100)__qaPaints.shift()}return r}};true"""%json.dumps(cid))
 for fi,file in enumerate(config['files']):
  opened=api('window.api.pdf.openPath('+json.dumps(file)+')');assert opened['ok'],opened
  settle();first=stats()
  # Ensure initial Next and prefetch have completed, rather than timing their preparation.
  if first:
   deadline=time.monotonic()+30
   while time.monotonic()<deadline:
    time.sleep(.2);other=stats()
    if other.get('stats') and first.get('stats') and other['stats']['backend']['rasterized']==first['stats']['backend']['rasterized'] and not other['stats']['inFlightBytes']:break
    first=other
  opened_stats=stats()
  record('open-'+str(fi),{'pages':opened['totalSlides'],'stats':opened_stats})
  for pi,page in enumerate(config.get('pages',[2,3,4,5,10,20,50,80,2])):
   if page>opened['totalSlides']:continue
   # Start each window's clock immediately before the navigation request.
   for c in peers.values():c.evaluate('globalThis.__qaStart=performance.now();true')
   at=api("Date.now()");api('window.api.nav.goto('+str(page)+')')
   def wait_paint(item):
    role,c=item
    return role,c.evaluate("""(async()=>{const start=__qaStart;while(!__qaPaints.some(t=>t>=start)){if(performance.now()-start>120000)throw Error('No product paint');await new Promise(r=>setTimeout(r,5))}const ready=__qaPaints.find(t=>t>=start)-start;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return ready})()""",timeout=125)
   with ThreadPoolExecutor(max_workers=3) as pool: timings=dict(pool.map(wait_paint,peers.items()))
   images={role:paint_snapshot(role,f'file-{fi}-page-{page}-{role}.png' if page in config.get('capturePages',[2,20]) else None) for role in roles}
   after=stats()
   sample={'fixture':fi,'page':page,'readyMs':timings,'images':images}
   if after:
    sample['renders']=[x for x in after['stats']['backend']['recent'] if x['at']>=at]
    if pi==0 and page==2:
     prepared=[x['key'] for x in opened_stats['stats']['backend']['recent'] if x['key']['page']==2]
     repeated=[x['key'] for x in sample['renders'] if x['key']['page']==2 and x['key'] in prepared]
     assert not repeated,('Prepared Next was rerendered',repeated)
     sample['preparedNextKeys']=prepared
   result['samples'].append(sample);save();settle()
  record('file-end-'+str(fi),stats())
  if fi==0 and len(config['files'])>1:
   before=stats();page=state()['currentSlide'];old=paint_snapshot('audience')
   api('window.api.preview.openPath('+json.dumps(config['files'][1])+')');settle()
   assert state()['currentSlide']==page and paint_snapshot('audience')==old,'Preview replaced PGM pixels'
   after=stats()
   if after:assert after['stats']['backend']['opened']==before['stats']['backend']['opened']+1,'Preview reopened PGM worker'
   record('independent-preview',{'preservedPGM':True,'before':before,'after':after})
   api('window.api.preview.clear()');settle()
 # Exercise TAKE from independently staged PDF. Preserve prepared document identity.
 api('window.api.preview.openPath('+json.dumps(config['files'][0])+')');settle()
 api('window.api.preview.goto(3)');api("window.api.preview.setSlideTakeMode('from-current')")
 before=stats();api("window.api.preview.take('fade')");settle();s=state()
 assert s['pdfPath']==config['files'][0],s['pdfPath']
 after=stats()
 if after:assert after['stats']['backend']['opened']==before['stats']['backend']['opened'],'TAKE reopened existing PDF'
 record('take-fade',{'page':s['currentSlide'],'reusedDocument':True})
 if config['mode']=='shared' and config.get('crash',True):
  before=stats();main=target(inspector,'file://')
  main.evaluate("globalThis.__qaElectron=process.getBuiltinModule('module').createRequire(process.execPath)('electron');true")
  main.evaluate('__qaElectron.webContents.fromId('+str(before['ownerId'])+').forcefullyCrashRenderer();true');main.close()
  time.sleep(2);deadline=time.monotonic()+30
  while True:
   after=stats()
   if after.get('stats') and after['incarnation']>before['incarnation'] and after['stats']['transport']['acknowledged']>=3:break
   if time.monotonic()>deadline:raise RuntimeError('Owner did not recover')
   time.sleep(.2)
  record('owner-recovery',{'before':before['incarnation'],'after':after['incarnation'],'images':{role:paint_snapshot(role) for role in roles}})
 result['pass']=True
except Exception as error:
 result['error']=str(error);raise
finally:
 save()
 for c in peers.values():c.close()
