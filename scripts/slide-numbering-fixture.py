# Run: uv run --with python-pptx python scripts/slide-numbering-fixture.py
from pptx import Presentation
from pptx.util import Inches
from lxml import etree
from pathlib import Path
p=Presentation()
for i in range(3):
 s=p.slides.add_slide(p.slide_layouts[6])
 text=s.shapes.add_textbox(Inches(1),Inches(1),Inches(8),Inches(3))
 text.text=f'Source slide {i+1}'
 if i==2:
  text.text_frame.add_paragraph().text='First click'
  text.text_frame.add_paragraph().text='Second click'
  def click(para):
   return f'<p:par><p:cTn><p:childTnLst><p:par><p:cTn><p:childTnLst><p:par><p:cTn presetClass="entr" nodeType="clickEffect"><p:childTnLst><p:set><p:cBhvr><p:tgtEl><p:spTgt spid="{text.shape_id}"><p:txEl><p:pRg st="{para}" end="{para}"/></p:txEl></p:spTgt></p:tgtEl></p:cBhvr></p:set></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>'
  timing=f'<p:timing xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:tnLst><p:par><p:cTn nodeType="tmRoot"><p:childTnLst><p:seq><p:cTn nodeType="mainSeq"><p:childTnLst>{click(1)}{click(2)}</p:childTnLst></p:cTn></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'
  s._element.append(etree.fromstring(timing))
output = Path(__file__).resolve().parent.parent / 'generated' / 'slide-numbering-qa' / 'three-slides.pptx'
output.parent.mkdir(parents=True, exist_ok=True)
p.save(str(output))
