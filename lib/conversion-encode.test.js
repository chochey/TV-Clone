const {test}=require('node:test');const assert=require('node:assert/strict');
const {buildCompatibleArgs,inspectSource,cpuList,allowedCpus,compatibleStreamPlan,verifyCompatibleAudio}=require('./conversion-encode');
const source=(codec='hevc',audio='ac3')=>({streams:[{index:0,codec_type:'video',codec_name:codec,pix_fmt:'yuv420p',height:1080},{index:1,codec_type:'audio',codec_name:audio,channels:6}]});
test('browser preset uses H264 and default stereo AAC while retaining surround',()=>{
 const args=buildCompatibleArgs('/in.mkv','/out.mp4',source(),{cpuCores:2});
 assert.ok(args.includes('libx264'));assert.equal(args[args.indexOf('-c:a:0')+1],'aac');
 assert.equal(args[args.indexOf('-ac:a:0')+1],'2');assert.equal(args[args.indexOf('-c:a:1')+1],'copy');
});
test('compatible H264 and stereo AAC are copied without recompression or duplication',()=>{
 const input=source('h264','aac');input.streams[1].channels=2;
 const args=buildCompatibleArgs('/in.mkv','/out.mp4',input);
 assert.equal(args[args.indexOf('-c:v')+1],'copy');assert.equal(args[args.indexOf('-c:a:0')+1],'copy');assert.ok(!args.includes('-c:a:1'));
});
test('HDR and image subtitles are rejected before encoding',()=>{
 const hdr=source();hdr.streams[0].color_transfer='smpte2084';assert.throws(()=>inspectSource(hdr),/HDR/);
 const subs=source();subs.streams.push({codec_type:'subtitle',codec_name:'hdmv_pgs_subtitle'});assert.throws(()=>inspectSource(subs),/Image subtitles/);
});
test('CPU affinity never selects CPUs outside the allowed set',()=>{
 const selected=cpuList(2).split(',').map(Number);assert.equal(selected.length,Math.min(2,allowedCpus().length));assert.ok(selected.every(cpu=>allowedCpus().includes(cpu)));
});

function multilingualSource() {
 return {streams:[
  {index:0,codec_type:'video',codec_name:'h264',pix_fmt:'yuv420p'},
  {index:2,codec_type:'audio',codec_name:'aac',channels:2,tags:{language:'spa',title:'Spanish main'},disposition:{default:1}},
  {index:4,codec_type:'audio',codec_name:'aac',channels:2,tags:{language:'eng',title:'Director commentary'},disposition:{default:1,comment:1}},
  {index:8,codec_type:'audio',codec_name:'ac3',channels:6,tags:{language:'en-US',title:'English main'},disposition:{default:0}},
 ]};
}
test('conversion selects main English over default foreign stereo and English commentary while retaining all tracks',()=>{
 const input=multilingualSource(),before=JSON.stringify(input),args=buildCompatibleArgs('/in.mkv','/out.mp4',input);
 assert.equal(inspectSource(input).primary.index,8);
 assert.deepEqual(args.flatMap((value,index)=>value==='-map'?[args[index+1]]:[]),['0:0','0:8','0:2','0:4','0:8']);
 assert.deepEqual(compatibleStreamPlan(input).map(track=>track.sourceIndex),[0,8,2,4,8]);
 assert.equal(args[args.indexOf('-disposition:a:0')+1],'default');
 assert.equal(args[args.indexOf('-disposition:a:1')+1],'0');
 assert.equal(args[args.indexOf('-disposition:a:2')+1],'comment');
 assert.equal(args[args.indexOf('-disposition:a:3')+1],'0');
 const metadata=index=>args.flatMap((value,i)=>value===`-metadata:s:a:${index}`?[args[i+1]]:[]);
 assert.deepEqual(metadata(0),['language=eng','title=English main (Browser stereo)','handler_name=English main (Browser stereo)']);
 assert.ok(metadata(1).includes('language=spa'));assert.ok(metadata(2).includes('title=Director commentary'));
 assert.ok(metadata(3).includes('title=English main'));assert.equal(JSON.stringify(input),before);
});
test('compatible English stereo is moved to the default output without duplicating it',()=>{
 const input=multilingualSource();input.streams[3].codec_name='aac';input.streams[3].channels=2;
 const args=buildCompatibleArgs('/in.mkv','/out.mp4',input);
 assert.deepEqual(compatibleStreamPlan(input).map(track=>track.sourceIndex),[0,8,2,4]);
 assert.equal(args[args.indexOf('-c:a:0')+1],'copy');assert.equal(args.includes('-c:a:3'),false);
 assert.ok(args.includes('title=English main'));assert.equal(args.includes('title=English main (Browser stereo)'),false);
});
test('conversion keeps the existing default selection when English is absent',()=>{
 const input=multilingualSource();input.streams=input.streams.filter(track=>track.index<4);
 assert.equal(inspectSource(input).primary.index,2);assert.deepEqual(compatibleStreamPlan(input).map(track=>track.sourceIndex),[0,2]);
});
test('generic MP4 handler names do not become titles on the browser stereo track',()=>{
 for(const handler of ['SoundHandler','AudioHandler','sound handler']) {
  const input=source('h264','ac3');input.streams[1].tags={language:'eng',handler_name:handler};
  const args=buildCompatibleArgs('/in.mp4','/out.mp4',input);
  assert.ok(args.includes('title=Browser stereo'));assert.ok(args.includes('handler_name=Browser stereo'));
  assert.equal(args.some(value=>value.includes(handler)),false);
  const output={streams:[
   {index:1,codec_type:'audio',tags:{language:'eng',handler_name:'Browser stereo'},disposition:{default:1}},
   {index:2,codec_type:'audio',tags:{language:'eng',handler_name:'SoundHandler'},disposition:{default:0}},
  ]};
  assert.doesNotThrow(()=>verifyCompatibleAudio(input,output));
 }
});
test('verification rejects wrong default, lost language, and mismatched mapped track names before replacement',()=>{
 const input=multilingualSource(),plan=compatibleStreamPlan(input).filter(track=>track.type==='audio');
 const output={streams:plan.map((row,i)=>{
  const from=input.streams.find(track=>track.index===row.sourceIndex);
  return {...from,index:i+1,tags:{language:from.tags.language==='en-US'?'eng':from.tags.language,
   handler_name:from.tags.title+(i===0?' (Browser stereo)':'')},disposition:{default:i===0?1:0}};
 })};
 assert.doesNotThrow(()=>verifyCompatibleAudio(input,output));
 const changed=()=>structuredClone(output);
 const wrongDefault=changed();wrongDefault.streams[1].disposition.default=1;
 assert.throws(()=>verifyCompatibleAudio(input,wrongDefault),/default track/);
 const wrongLanguage=changed();wrongLanguage.streams[0].tags.language='spa';
 assert.throws(()=>verifyCompatibleAudio(input,wrongLanguage),/language metadata/);
 const wrongTitle=changed();wrongTitle.streams[0].tags.handler_name='Director commentary';
 assert.throws(()=>verifyCompatibleAudio(input,wrongTitle),/track titles/);
});
