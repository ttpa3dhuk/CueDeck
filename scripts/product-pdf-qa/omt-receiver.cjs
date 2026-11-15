// Independent libomt observer, separate process; no CueDeck source imports.
const fs=require('node:fs'),path=require('node:path'),koffi=require('koffi')
const [source,output]=process.argv.slice(2)
if(!source||source.length>256||!output)throw Error('Expected source and report path')
const directory=process.env.OMT_LIB_DIR
const ext=process.platform==='win32'?'dll':'dylib'
koffi.load(path.join(directory,'libvmx.'+ext))
const library=koffi.load(path.join(directory,'libomt.'+ext))
koffi.struct('ProductQaFrame',{Type:'int32',Timestamp:'int64',Codec:'int32',Width:'int32',Height:'int32',Stride:'int32',Flags:'int32',FrameRateN:'int32',FrameRateD:'int32',AspectRatio:'float',ColorSpace:'int32',SampleRate:'int32',Channels:'int32',SamplesPerChannel:'int32',Data:'void *',DataLength:'int32',CompressedData:'void *',CompressedLength:'int32',FrameMetadata:'void *',FrameMetadataLength:'int32'})
const create=library.func('void *omt_receive_create(const char *,int,int,int)'),receive=library.func('ProductQaFrame *omt_receive(void *,int,int)'),destroy=library.func('void omt_receive_destroy(void *)')
const instance=create(source,2,2,0)
if(!instance)throw Error('Cannot create receiver')
const stats={source,frames:0,sizes:[],errors:[],hashes:[]};let stopping=false,pending=false
function lane(){if(stopping)return;pending=true;receive.async(instance,2,100,(error,pointer)=>{
 pending=false
 try{if(error)throw error;if(pointer){const f=koffi.decode(pointer,'ProductQaFrame');if(f.Type!==2||!f.Data||f.Width<1||f.Height<1||f.Stride<f.Width*4||f.DataLength<f.Stride*f.Height||f.DataLength>128*1024*1024)throw Error('Invalid OMT frame');stats.frames++;const size=f.Width+'x'+f.Height;if(!stats.sizes.includes(size))stats.sizes.push(size);if(stats.frames%10===1){const bytes=koffi.decode(f.Data,koffi.array('uint8_t',f.Stride*f.Height,'Typed'));let hash=0;for(let i=0;i<bytes.length;i+=4096)hash=(Math.imul(hash,31)+bytes[i])>>>0;if(!stats.hashes.includes(hash))stats.hashes.push(hash)}}}catch(e){stats.errors.push(String(e));stopping=true}
 if(!stopping)setTimeout(lane,0)
})}
lane()
setTimeout(async()=>{stopping=true;const deadline=Date.now()+2000;while(pending&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));if(pending)stats.errors.push('Native receive did not drain');else destroy(instance);stats.pass=stats.frames>=50&&stats.hashes.length>1&&stats.errors.length===0;fs.writeFileSync(output,JSON.stringify(stats,null,2));console.log(JSON.stringify(stats));process.exitCode=stats.pass?0:1},8000)
