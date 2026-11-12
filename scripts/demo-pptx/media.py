"""Generate only synthetic media; no borrowed presentations or recordings."""
from pathlib import Path
from PIL import Image, ImageDraw
import subprocess
root = Path(__file__).resolve().parents[2] / 'demos/powerpoint/media'
root.mkdir(parents=True, exist_ok=True)
for name, transparent in [('orbit', False), ('transparent', True)]:
    frames = []
    for i in range(16):
        image = Image.new('RGBA', (480, 270), (16, 23, 36, 0 if transparent else 255))
        draw = ImageDraw.Draw(image)
        draw.ellipse((15+i*22, 75, 95+i*22, 155), fill=(62, 214, 142, 255))
        frames.append(image)
    frames[0].save(root / (name+'.gif'), save_all=True, append_images=frames[1:], duration=100, loop=0, disposal=2, optimize=False)
for name, frequency, hue in [('clip-a', 440, None), ('clip-b', 880, '100')]:
    cmd = ['ffmpeg','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=960x540:rate=30:duration=4','-f','lavfi','-i',f'sine=frequency={frequency}:duration=4']
    if hue: cmd += ['-vf', f'hue=h={hue}']
    subprocess.run(cmd+['-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest','-y',str(root/(name+'.mp4'))],check=True)
