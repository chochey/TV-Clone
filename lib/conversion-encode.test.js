const {test}=require('node:test');const assert=require('node:assert/strict');
const {buildCompatibleArgs,inspectSource,cpuList,allowedCpus}=require('./conversion-encode');
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
