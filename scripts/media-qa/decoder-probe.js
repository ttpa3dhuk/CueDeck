async function probeMedia(url, seconds=8, audio=true) {
  url += '?qa=' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const v=document.createElement('video');v.id='qa-decoder';v.crossOrigin='anonymous';v.preload='auto';v.muted=!audio;v.style.cssText='position:fixed;left:0;top:0;width:90vw;height:80vh;z-index:2147483647;background:#111;object-fit:contain';document.body.append(v);
  const result={url,events:[],frames:[],audio:[],errors:[],startedAt:Date.now()};
  let ac,split,gain,analysers=[],stopped=false,callback;
  const now=()=>Date.now()-result.startedAt;
  for(const name of ['loadedmetadata','loadeddata','playing','waiting','seeking','seeked','stalled','ended','error'])v.addEventListener(name,()=>result.events.push({event:name,at:now(),time:v.currentTime,ready:v.readyState}));
  function frame(at,m){if(stopped)return;result.frames.push({at:now(),time:m.mediaTime});callback=v.requestVideoFrameCallback(frame)}
  callback=v.requestVideoFrameCallback(frame);
  try {
    if(audio){ac=new AudioContext({sampleRate:48000});split=ac.createChannelSplitter(2);gain=ac.createGain();gain.gain.value=0;gain.connect(ac.destination);ac.createMediaElementSource(v).connect(split);for(let ch=0;ch<2;ch++){const a=ac.createAnalyser();a.fftSize=4096;split.connect(a,ch);a.connect(gain);analysers.push(a)}await ac.resume()}
    v.src=url;
    await Promise.race([v.play(),new Promise((_,reject)=>setTimeout(()=>reject(Error('play timeout')),7000))]);
    result.playAt=now();result.metadata={width:v.videoWidth,height:v.videoHeight,duration:v.duration,audioContextRate:ac?.sampleRate};
    const before=v.getVideoPlaybackQuality();result.qualityBefore={total:before.totalVideoFrames,dropped:before.droppedVideoFrames};
    const end=performance.now()+seconds*1000;
    while(performance.now()<end){await new Promise(r=>setTimeout(r,200));if(v.error)throw Error(v.error.message);if(audio){const channels=analysers.map((a,ch)=>{const x=new Float32Array(a.fftSize);a.getFloatTimeDomainData(x);let power=0,re=0,im=0;const f=ch?880:440;for(let i=0;i<x.length;i++){power+=x[i]*x[i];const phase=2*Math.PI*f*i/ac.sampleRate;re+=x[i]*Math.cos(phase);im-=x[i]*Math.sin(phase)}return {rms:Math.sqrt(power/x.length),toneAmplitude:2*Math.hypot(re,im)/x.length}});result.audio.push({at:now(),channels})}}
    result.measureEndAt=now();
    const q=v.getVideoPlaybackQuality();result.qualityAfter={total:q.totalVideoFrames,dropped:q.droppedVideoFrames};result.endTime=v.currentTime;
    v.pause();v.currentTime=2;
    const deadline=performance.now()+5000;while((v.seeking||v.readyState<2)&&performance.now()<deadline)await new Promise(r=>setTimeout(r,50));
    result.seek={seeking:v.seeking,ready:v.readyState,time:v.currentTime,paused:v.paused};
  }catch(error){result.errors.push(String(error));result.mediaError=v.error?{code:v.error.code,message:v.error.message}:null}
  finally{stopped=true;v.cancelVideoFrameCallback(callback);v.pause();v.removeAttribute('src');v.load();v.remove();if(ac)await ac.close()}
  const timed=result.frames.filter(x=>x.at>=result.playAt&&x.at<=result.measureEndAt);const gaps=timed.slice(1).map((x,i)=>x.at-timed[i].at);
  result.summary={presentedFrames:timed.length,maxFrameGapMs:gaps.length?Math.max(...gaps):null,measurementSeconds:result.measureEndAt!==undefined?(result.measureEndAt-result.playAt)/1000:0,errors:result.errors.length,seekOK:!!result.seek&&!result.seek.seeking&&result.seek.ready>=2&&Math.abs(result.seek.time-2)<.2};
  return result;
}
