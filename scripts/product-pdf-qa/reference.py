"""Separate quality-only run: independent legacy PDF.js at canonical integer raster size.
Never include its extra worker/document in performance measurements.
"""
import sys,json,base64
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'release-qa'))
from cdp import target
cfg=json.loads(Path(sys.argv[1]).read_text());root=Path(cfg['localOutput']);r=json.loads((root/'result.json').read_text());c=target(cfg.get('cdpPort',12181),'role=operator')
asset=sys.argv[2];rows=[]
try:
 for fi,file in enumerate(cfg['files']):
  c.evaluate('window.api.pdf.openPath('+json.dumps(file)+')',timeout=120)
  c.evaluate("(async()=>{globalThis.__refModule=await import(new URL('../assets/"+asset+"',location.href).href);globalThis.__refLoader=new __refModule.PdfLoader();const data=await window.api.pdf.read();const state=await window.api.state.get();if(data.pdf)data.pdf.url='cuedeck-media://document/program?v='+state.pdfSha1;await __refLoader.loadDocument(data.pdf??data.bytes);return true})()",timeout=120)
  for sample in [s for s in r['samples'] if s['fixture']==fi and s['page'] in cfg.get('capturePages',[2,20])]:
   for role,actual in sample['images'].items():
    value=c.evaluate("""(async()=>{const canvas=document.createElement('canvas');await __refLoader.renderPageTo(%d,canvas,%d/(window.devicePixelRatio>2?2:window.devicePixelRatio));const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;return {width:canvas.width,height:canvas.height,hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),b=>b.toString(16).padStart(2,'0')).join(''),png:canvas.toDataURL()}})()"""%(sample['page'],actual['width']),timeout=120)
    filename=f"reference-{fi}-{sample['page']}-{role}.png";(root/filename).write_bytes(base64.b64decode(value.pop('png').split(',')[1]))
    rows.append({'fixture':fi,'page':sample['page'],'role':role,'actual':actual,'reference':value,'exact':actual==value})
  c.evaluate('(async()=>{await __refLoader.getDocument().destroy();delete globalThis.__refLoader;return true})()',timeout=120)
finally:
 c.close();(root/'reference.json').write_text(json.dumps(rows,indent=2))
print('Exact',sum(x['exact'] for x in rows),'/',len(rows))
