// Independent SDK observer of CueDeck's actual output, with no product imports.
const fs=require('node:fs'),path=require('node:path'),koffi=require('koffi'),{performance}=require('node:perf_hooks')
const [source,output,duration]=process.argv.slice(2),seconds=Number(duration||15)
if(!/^omt:\/\/[^\s/]+:\d+$/.test(source||'')||!Number.isFinite(seconds)||seconds<5||seconds>120)throw Error('Invalid observer arguments')
fs.mkdirSync(output,{recursive:true})
const ext=process.platform==='win32'?'dll':'dylib'
koffi.load(path.join(process.env.OMT_LIB_DIR,'libvmx.'+ext))
const lib=koffi.load(path.join(process.env.OMT_LIB_DIR,'libomt.'+ext))
koffi.struct('QAFrame',{Type:'int32',Timestamp:'int64',Codec:'int32',Width:'int32',Height:'int32',Stride:'int32',Flags:'int32',FrameRateN:'int32',FrameRateD:'int32',AspectRatio:'float',ColorSpace:'int32',SampleRate:'int32',Channels:'int32',SamplesPerChannel:'int32',Data:'void *',DataLength:'int32',CompressedData:'void *',CompressedLength:'int32',FrameMetadata:'void *',FrameMetadataLength:'int32'})
lib.func('void omt_setloggingfilename(const char *filename)')(path.join(output,'sdk.log'))
const create=lib.func('void *omt_receive_create(const char *address,int types,int format,int flags)'),receive=lib.func('QAFrame *omt_receive(void *inst,int types,int timeoutMs)'),destroy=lib.func('void omt_receive_destroy(void *inst)')
const instance=create(source,6,2,0)
if(!instance)throw Error('OMT receive create failed')
const start=performance.now(),stats={source,videoFrames:0,changedFrames:0,audioFrames:0,pcmSeconds:0,missingAudioMs:0,backwards:0,ptsDiscontinuities:0,quiet10ms:0,nonFiniteSamples:0,firstVideoMs:null,firstAudioMs:null,errors:[]}
let stopping=false,pending=0,previousHash=null,previousPts=null,previousDuration=0,measuredFrames=0,quiet=0
const crossings=[0,0],previous=[0,0],energy=[0,0],packets=fs.openSync(path.join(output,'packets.jsonl'),'wx')
function decode(pointer){
 const f=koffi.decode(pointer,'QAFrame'),elapsed=performance.now()-start,pts=Number(f.Timestamp),measured=elapsed>=1500
 if(!Number.isFinite(pts)||f.DataLength<0||f.DataLength>128*1024*1024)throw Error('Invalid SDK frame')
 if(f.Type===2){
  if(f.Width<1||f.Height<1||f.Stride<f.Width*4||f.DataLength<f.Stride*f.Height)throw Error('Invalid video buffer')
  stats.firstVideoMs??=elapsed
  const data=koffi.decode(f.Data,koffi.array('uint8_t',f.Stride*f.Height,'Typed'))
  let hash=0;for(let i=0;i<data.length;i+=4096)hash=(Math.imul(hash,31)+data[i])>>>0
  if(measured){stats.videoFrames++;if(previousHash!==null&&hash!==previousHash)stats.changedFrames++}previousHash=hash
  fs.writeSync(packets,JSON.stringify({type:'video',elapsed,pts,width:f.Width,height:f.Height,hash})+'\n')
 }else if(f.Type===4){
  stats.firstAudioMs??=elapsed
  if(f.Codec!==0x31415046||f.SampleRate!==48000||f.Channels!==2||f.SamplesPerChannel<1||f.SamplesPerChannel>48000||f.DataLength<f.SamplesPerChannel*8)throw Error('Unexpected PCM format')
  const delta=previousPts===null?0:(pts-previousPts)/10000-previousDuration
  if(previousPts!==null&&Math.abs(delta)>1){stats.ptsDiscontinuities++;if(delta>0)stats.missingAudioMs+=delta;else stats.backwards++}
  previousPts=pts;previousDuration=f.SamplesPerChannel/48
  const data=koffi.decode(f.Data,koffi.array('float',f.SamplesPerChannel*2,'Typed'))
  if(measured){stats.audioFrames++;measuredFrames+=f.SamplesPerChannel;stats.pcmSeconds=measuredFrames/48000
   for(let i=0;i<f.SamplesPerChannel;i++){let loud=false
    for(let c=0;c<2;c++){const value=data[c*f.SamplesPerChannel+i];if(!Number.isFinite(value)){stats.nonFiniteSamples++;continue}
     energy[c]+=value*value;if(previous[c]<=0&&value>0)crossings[c]++;previous[c]=value;if(Math.abs(value)>1e-5)loud=true}
    if(loud)quiet=0;else if(++quiet===480)stats.quiet10ms++}}
  fs.writeSync(packets,JSON.stringify({type:'audio',elapsed,pts,frames:f.SamplesPerChannel,deltaMs:delta,measured})+'\n')
 }
}
function lane(type){if(stopping)return;pending++;receive.async(instance,type,20,(error,pointer)=>{pending--;try{if(error)throw error;if(pointer)decode(pointer)}catch(e){stats.errors.push(String(e));stopping=true}if(!stopping)setTimeout(()=>lane(type),0)})}
lane(2);lane(4)
async function finish(){
 stopping=true;const deadline=performance.now()+2000
 while(pending&&performance.now()<deadline)await new Promise(r=>setTimeout(r,10))
 if(pending)stats.errors.push('Native calls did not drain');else destroy(instance)
 fs.closeSync(packets)
 const frequency=crossings.map(n=>stats.pcmSeconds?n/stats.pcmSeconds:0),rms=energy.map(n=>measuredFrames?Math.sqrt(n/measuredFrames):0)
 const checks={video:stats.videoFrames>=(seconds-3)*15,motion:stats.changedFrames>=(seconds-3)*8,startup:stats.firstVideoMs!==null&&stats.firstVideoMs<3000&&stats.firstAudioMs!==null&&stats.firstAudioMs<3000,pcmDuration:stats.pcmSeconds>=seconds-3,left440:Math.abs(frequency[0]-440)<2,right880:Math.abs(frequency[1]-880)<2,signal:rms.every(x=>x>.005&&x<.2),pts:stats.ptsDiscontinuities===0,quiet:stats.quiet10ms===0,finite:stats.nonFiniteSamples===0,native:stats.errors.length===0}
 const result={...stats,frequency,rms,checks,final:true,ok:Object.values(checks).every(Boolean),limits:'First 1.5s excluded from content counts; startup and all PTS checked separately. Digital output only, no physical playback or A/V synchronization claim.'}
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));process.exitCode=result.ok?0:1
}
setTimeout(()=>finish().catch(e=>{console.error(e);process.exitCode=1}),seconds*1000)
