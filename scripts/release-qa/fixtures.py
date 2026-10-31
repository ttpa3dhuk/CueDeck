"""Create original, redistributable QA media. Never reads user presentations."""
import json
import struct
import subprocess
import zlib
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

COLORS = [(220, 40, 60), (40, 180, 90), (40, 90, 220)]


def png_bytes(width, height, color):
    def chunk(kind, body):
        return struct.pack('!I', len(body)) + kind + body + struct.pack('!I', zlib.crc32(kind + body) & 0xffffffff)
    pixels = (b'\0' + bytes(color) * width) * height
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b''))


def pdf_bytes():
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Count 3 /Kids [3 0 R 5 0 R 7 0 R] >>']
    for index, color in enumerate(COLORS):
        objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Resources << >> /Contents {4 + index*2} 0 R >>'.encode())
        drawing = (' '.join(str(c / 255) for c in color) + ' rg 0 0 960 540 re f\n').encode()
        objects.append(f'<< /Length {len(drawing)} >>\nstream\n'.encode() + drawing + b'endstream')
    output = bytearray(b'%PDF-1.4\n')
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f'{index} 0 obj\n'.encode() + obj + b'\nendobj\n')
    xref = len(output)
    output.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]:
        output.extend(f'{offset:010d} 00000 n \n'.encode())
    output.extend(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    return bytes(output)


def pptx_file(path):
    ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    rel = 'http://schemas.openxmlformats.org/package/2006/relationships'
    office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    types = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
    types += ''.join(f'<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' for i in range(1, 4)) + '</Types>'
    tree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
    files = {'[Content_Types].xml': types,
             '_rels/.rels': f'<Relationships xmlns="{rel}"><Relationship Id="rId1" Type="{office}/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
             'ppt/presentation.xml': f'<p:presentation {ns}><p:sldIdLst>' + ''.join(f'<p:sldId id="{255+i}" r:id="rId{i}"/>' for i in range(1, 4)) + '</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
             'ppt/_rels/presentation.xml.rels': f'<Relationships xmlns="{rel}">' + ''.join(f'<Relationship Id="rId{i}" Type="{office}/slide" Target="slides/slide{i}.xml"/>' for i in range(1, 4)) + '</Relationships>'}
    for i, color in enumerate(COLORS, 1):
        rgb = ''.join(f'{c:02X}' for c in color)
        files[f'ppt/slides/slide{i}.xml'] = f'<p:sld {ns}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="{rgb}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>{tree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
    with ZipFile(path, 'w', ZIP_DEFLATED) as archive:
        for name, text in files.items():
            archive.writestr(name, text.encode())


def create(folder, ffmpeg=None):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / '01_Кириллица.pdf').write_bytes(pdf_bytes())
    (folder / '03_image.png').write_bytes(png_bytes(960, 540, COLORS[2]))
    pptx_file(folder / '02_slides.pptx')
    if ffmpeg:
        subprocess.run([str(ffmpeg), '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
                        'testsrc2=size=960x540:rate=25', '-f', 'lavfi', '-i',
                        'aevalsrc=0.08*sin(2*PI*440*t)|0.08*sin(2*PI*880*t):s=48000',
                        '-t', '16', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
                        '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', str(folder / '04_video.mp4')],
                       check=True, timeout=90)
    (folder / 'manifest.json').write_text(json.dumps({'colors': COLORS, 'origin': 'Generated by CueDeck release-qa; no user content',
                                                   'video': 'testsrc2; stereo 440/880 Hz; 48 kHz; 16 seconds'}, indent=2))
    return folder


def png_pixel(data, fraction=(.5, .5)):
    """Decode an 8-bit RGB/RGBA PNG from Chromium, including all PNG filters."""
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('Not a PNG')
    offset, compressed, header = 8, bytearray(), None
    while offset < len(data):
        size = struct.unpack('!I', data[offset:offset+4])[0]
        kind, body = data[offset+4:offset+8], data[offset+8:offset+8+size]
        if len(body) != size or len(data) < offset+12+size:
            raise ValueError('Truncated PNG')
        crc = struct.unpack('!I', data[offset+8+size:offset+12+size])[0]
        if zlib.crc32(kind+body) & 0xffffffff != crc:
            raise ValueError('PNG checksum mismatch')
        if kind == b'IHDR':
            header = struct.unpack('!IIBBBBB', body)
        if kind == b'IDAT':
            compressed.extend(body)
        offset += size+12
        if kind == b'IEND':
            break
    if not header:
        raise ValueError('Missing PNG header')
    width, height, depth, color, compression, filtering, interlace = header
    if depth != 8 or color not in (2, 6) or compression or filtering or interlace or width*height > 32000000:
        raise ValueError('Unsupported screenshot PNG')
    channels = 3 if color == 2 else 4
    stride = width*channels
    raw = zlib.decompress(compressed)
    if len(raw) != (stride+1)*height:
        raise ValueError('PNG size mismatch')
    x = min(width-1, max(0, int(width*fraction[0])))
    y = min(height-1, max(0, int(height*fraction[1])))
    previous = bytearray(stride)
    for row in range(y+1):
        filter_type = raw[row*(stride+1)]
        current = bytearray(raw[row*(stride+1)+1:(row+1)*(stride+1)])
        if filter_type > 4:
            raise ValueError('Invalid PNG filter')
        for col in range(stride):
            left = current[col-channels] if col >= channels else 0
            up = previous[col]
            diagonal = previous[col-channels] if col >= channels else 0
            if filter_type == 1:
                current[col] = (current[col] + left) & 255
            elif filter_type == 2:
                current[col] = (current[col] + up) & 255
            elif filter_type == 3:
                current[col] = (current[col] + (left+up)//2) & 255
            elif filter_type == 4:
                p = left+up-diagonal
                distances = [abs(p-left), abs(p-up), abs(p-diagonal)]
                predictor = [left, up, diagonal][distances.index(min(distances))]
                current[col] = (current[col] + predictor) & 255
        previous = current
    return list(previous[x*channels:x*channels+3])
