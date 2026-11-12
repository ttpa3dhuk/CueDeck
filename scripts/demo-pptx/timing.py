"""Add reproducible PowerPoint timing and transition fixtures after pptxgenjs."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import re, json
root = Path(__file__).resolve().parents[2] / 'demos/powerpoint'
pptx = root / 'CueDeck-demo.pptx'
with ZipFile(pptx) as z: files = {n: z.read(n) for n in z.namelist()}

def click_groups(groups):
    seq=[]; uid=10
    for ids in groups:
        effects=[]
        for shape in ids:
            uid+=2
            effects.append(f'<p:par><p:cTn id="{uid}" presetID="1" presetClass="entr" presetSubtype="0" fill="hold" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:set><p:cBhvr><p:cTn id="{uid+1}" dur="1" fill="hold"/><p:tgtEl><p:spTgt spid="{shape}"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set></p:childTnLst></p:cTn></p:par>')
        uid+=2
        seq.append(f'<p:par><p:cTn id="{uid}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="{uid+1}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>{"".join(effects)}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>')
    return '<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>'+''.join(seq)+'</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>'

for number in range(1,len(json.loads((root/'cases.json').read_text()))+1):
    name=f'ppt/slides/slide{number}.xml'; xml=files[name].decode()
    # Keep media IDs tied to their preview rId; move text/image IDs out of that range.
    index=[100]
    def ids(m):
        if 'name="video-' in m[0]: return m[0]
        index[0]+=1
        return re.sub(r'\bid="\d+"', f'id="{index[0]}"', m[0], count=1)
    xml=re.sub(r'<p:cNvPr\b[^>]*>', ids, xml)
    xml=re.sub(r' descr="[^"]*"','',xml) # no workstation paths in the portable deck
    content=''
    if number == 4:
        xml=xml.replace('<p:sld ', '<p:sld xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" ',1)
        xml=xml.replace('<p:clrMapOvr>', '<p:transition spd="fast" p14:dur="400"><p:fade/></p:transition><p:clrMapOvr>')
        # Transition follows clrMapOvr in CT_Slide.
        transition='<p:transition spd="fast" p14:dur="400"><p:fade/></p:transition>'
        xml=xml.replace(transition,'').replace('</p:sld>',transition+'</p:sld>')
    if number in (5,15):
        if number==5:
            pairs=[]
            for i in range(3):
                shape=re.search(r'<p:cNvPr id="(\d+)" name="build-'+str(i)+'"',xml).group(1)
                text=re.search(r'<p:cNvPr id="(\d+)" name="Text '+str(4+i*2)+'"',xml).group(1)
                pairs.append([shape,text])
        else: pairs=[[re.search(r'<p:cNvPr id="(\d+)" name="gif-orbit"',xml).group(1)]]
        content=click_groups(pairs)
    if number in (6,7,8,10,11,16):
        shape=re.search(r'<p:cNvPr id="(\d+)" name="video-',xml).group(1)
        delay='indefinite' if number==10 else '0'
        repeat=' repeatCount="indefinite"' if number==11 else ''
        content=f'<p:video><p:cMediaNode vol="80000"><p:cTn id="2" fill="hold"{repeat}><p:stCondLst><p:cond delay="{delay}"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="{shape}"/></p:tgtEl></p:cMediaNode></p:video>'
    if content:
        timing='<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>'+content+'</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'
        xml=xml.replace('</p:sld>',timing+'</p:sld>')
    files[name]=xml.encode()
with ZipFile(pptx,'w',ZIP_DEFLATED) as z:
    for name,data in files.items(): z.writestr(name,data)
print(pptx)
