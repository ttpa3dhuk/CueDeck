"""Synthetic compatibility corpus with recorded recipes and hashes."""
import argparse, hashlib, json, subprocess
from pathlib import Path

AUDIO = 'aevalsrc=0.06*sin(2*PI*440*t)|0.06*sin(2*PI*880*t):s=48000'
CASES = [
 ('h264-1080p30.mp4','1920x1080',30,['-c:v','h264_videotoolbox','-b:v','8M','-level:v','4.1','-pix_fmt','yuv420p','-profile:v','high'],['-c:a','aac','-b:a','192k']),
 ('h264-1080p60.mp4','1920x1080',60,['-c:v','h264_videotoolbox','-b:v','12M','-level:v','4.2','-pix_fmt','yuv420p','-profile:v','high'],['-c:a','aac','-b:a','192k']),
 ('h264-4k30.mp4','3840x2160',30,['-c:v','h264_videotoolbox','-b:v','20M','-level:v','5.1','-pix_fmt','yuv420p','-profile:v','high'],['-c:a','aac','-b:a','192k']),
 ('h264-4k60.mp4','3840x2160',60,['-c:v','h264_videotoolbox','-b:v','35M','-level:v','5.2','-pix_fmt','yuv420p','-profile:v','high'],['-c:a','aac','-b:a','192k']),
 ('hevc-4k30.mp4','3840x2160',30,['-c:v','hevc_videotoolbox','-b:v','12M','-pix_fmt','yuv420p','-tag:v','hvc1'],['-c:a','aac','-b:a','192k']),
 ('hevc10-4k30.mp4','3840x2160',30,['-c:v','hevc_videotoolbox','-b:v','12M','-pix_fmt','p010le','-profile:v','main10','-tag:v','hvc1'],['-c:a','aac','-b:a','192k']),
 ('vp9-1080p30.webm','1920x1080',30,['-c:v','libvpx-vp9','-deadline','realtime','-cpu-used','8','-row-mt','1','-b:v','5M','-pix_fmt','yuv420p'],['-c:a','libopus','-b:a','128k']),
 ('av1-1080p30.mp4','1920x1080',30,['-c:v','libsvtav1','-preset','12','-crf','35','-pix_fmt','yuv420p','-svtav1-params','lp=4'],['-c:a','aac','-b:a','192k']),
 ('mpeg4-720p30.avi','1280x720',30,['-c:v','mpeg4','-q:v','5'],['-c:a','libmp3lame','-b:a','192k']),
 ('prores-1080p30.mov','1920x1080',30,['-c:v','prores_ks','-profile:v','0','-pix_fmt','yuv422p10le','-threads','4'],['-c:a','pcm_s16le']),
]
SOUND = [
 ('mp3-cbr.mp3',['-c:a','libmp3lame','-b:a','192k']),
 ('mp3-vbr-44100.mp3',['-c:a','libmp3lame','-q:a','3','-ar','44100']),
 ('wav16.wav',['-c:a','pcm_s16le']),('wav24.wav',['-c:a','pcm_s24le']),
 ('wav-float.wav',['-c:a','pcm_f32le']),('aac.m4a',['-c:a','aac','-b:a','192k']),
 ('aac-adts.aac',['-c:a','aac','-b:a','192k']),('flac.flac',['-c:a','flac']),
 ('opus.ogg',['-c:a','libopus','-b:a','128k']),('pcm.aiff',['-c:a','pcm_s16be']),
 ('wma.wma',['-c:a','wmav2','-b:a','192k']),
]
def create(folder, seconds=18):
 folder=Path(folder);folder.mkdir(parents=True,exist_ok=True)
 manifest={'schema':1,'source':'Synthetic moving testsrc2 and stereo440/880Hz at0.06 amplitude; no user media','seconds':seconds,'cases':[]}
 for name,size,fps,video,audio in CASES:
  command=['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i',f'testsrc2=size={size}:rate={fps}','-f','lavfi','-i',AUDIO,'-t',str(seconds),*video,'-g',str(fps*2),*audio]
  if name.endswith('.mp4'):command+=['-movflags','+faststart']
  yield name,command,folder,manifest
 for name,codec in SOUND:
  yield name,['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i',AUDIO,'-t',str(seconds),*codec],folder,manifest
 # Same elementary streams, different container. This isolates extension/container acceptance.
 yield 'h264-1080p30.mkv',['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-n','-i',str(folder/'h264-1080p30.mp4'),'-c','copy'],folder,manifest

def main():
 ap=argparse.ArgumentParser();ap.add_argument('folder');ap.add_argument('--only');a=ap.parse_args()
 previous_path=Path(a.folder)/'manifest.json'
 previous={x['name']:x for x in json.loads(previous_path.read_text())['cases']} if previous_path.exists() else {}
 records=dict(previous);checked=0
 for name,command,folder,manifest in create(a.folder):
  if a.only and a.only not in name:continue
  out=folder/name
  if out.exists() and previous.get(name,{}).get('command') != [*command,str(out)]:raise RuntimeError('Existing fixture has a different recipe; use a new folder: '+name)
  if out.exists() and hashlib.sha256(out.read_bytes()).hexdigest()!=previous[name]['sha256']:raise RuntimeError('Existing fixture bytes changed: '+name)
  if not out.exists():
   print('ENCODE',name,flush=True);subprocess.run([*command,str(out)],check=True,timeout=240)
  info=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(out)]))
  records[name]={'name':name,'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'bytes':out.stat().st_size,'command':[*command,str(out)],'probe':info}
  manifest['cases']=list(records.values());checked+=1
  (folder/'manifest.json').write_text(json.dumps(manifest,indent=2))
 print('DONE',checked,flush=True)
if __name__=='__main__':main()
