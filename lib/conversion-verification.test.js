const {test}=require('node:test');const assert=require('node:assert/strict');
const {createPacketCollector,validateSourcePackets,verifyPacketPreservation,verifyDecodedSample,verifyDecodeDiagnostics}=require('./conversion-verification');
const probe={streams:[{index:0,codec_type:'video',avg_frame_rate:'24/1'},{index:1,codec_type:'audio'}],format:{duration:'2',start_time:'0'}};
function inventory(durations=[2,2],counts=[48,94]) {
 return {warnings:'',warningBytes:0,streams:durations.map((duration,index)=>({index,type:index?'audio':'video',packets:counts[index],min:0,end:duration,duration,backwards:0,missingTimestamps:0}))};
}
const plan=[{sourceIndex:0,type:'video',copied:true},{sourceIndex:1,type:'audio',copied:false}];
test('packet collection handles split lines and drains warning output into a bounded buffer',()=>{
 const collector=createPacketCollector(probe);collector.write('stream_index=0|pts_time=0.000|dts_time=-0.083|duration_time=0.041\nstrea');
 collector.write('m_index=0|pts_time=0.041|dts_time=-0.041|duration_time=0.041\n');
 collector.warn('Vorbis Invalid packet\n'.repeat(100000));const result=collector.finish();
 assert.equal(result.streams[0].packets,2);assert.equal(result.streams[0].duration,0.082);
 assert.equal(result.warnings.length<=4096,true);assert.equal(result.warningBytes>1e6,true);
 assert.throws(()=>validateSourcePackets(probe,result),/Needs review: source packet parser/);
});
test('a source declared much longer than its actual packets needs review even when output would match',()=>{
 const truncated={...probe,format:{duration:'1332.010',start_time:'0'}};
 assert.throws(()=>validateSourcePackets(truncated,inventory([331.8,331.8])),/1332\.010s.*331\.800s/);
});
test('source video/audio timestamp inconsistencies need review',()=>{
 const packets=inventory();packets.streams[0].backwards=1;
 assert.throws(()=>validateSourcePackets(probe,packets),/backwards DTS 1/);
});
test('subtitle packets may legitimately extend container duration beyond the media',()=>{
 const source={...probe,streams:[...probe.streams,{index:2,codec_type:'subtitle'}],format:{duration:'5',start_time:'0'}};
 const packets=inventory();packets.streams.push({index:2,type:'subtitle',packets:1,min:4,end:5,duration:1});
 assert.equal(validateSourcePackets(source,packets),2);
});
test('shortened video cannot pass merely because audio preserves the aggregate duration',()=>{
 const source=inventory([10,10]), output=inventory([5,10]);
 assert.throws(()=>verifyPacketPreservation(source,output,plan,probe),/video track 0 duration.*10\.000s.*5\.000s/);
});
test('every mapped track and every copied packet must survive conversion',()=>{
 assert.throws(()=>verifyPacketPreservation(inventory(),inventory([2,2],[47,94]),plan,probe),/lost packets/);
 assert.throws(()=>verifyPacketPreservation(inventory(),inventory(),[...plan,{sourceIndex:1,type:'audio',copied:false}],probe),/stream count/);
});
test('decode checks require actual video frames and audio samples including a complete audio sample window',()=>{
 assert.throws(()=>verifyDecodedSample('frame=0\nout_time_us=3000000\n',{index:0,codec_type:'video'},0,3),/no frames/);
 assert.throws(()=>verifyDecodedSample('out_time_us=0\n',{index:1,codec_type:'audio',sample_rate:'48000'},0,3),/no samples/);
 assert.throws(()=>verifyDecodedSample('out_time_us=1000000\n',{index:1,codec_type:'audio',sample_rate:'48000'},0,3),/only 1\.000s/);
 assert.equal(verifyDecodedSample('out_time_us=3000000\n',{index:1,codec_type:'audio',sample_rate:'48000'},0,3),144000);
 assert.throws(()=>verifyDecodedSample('frame=1\n',{index:0,codec_type:'video',avg_frame_rate:'24/1'},0,3),/expected at least/);
});
test('decoder errors fail verification even if ffmpeg exits successfully, while null-muxer DTS warnings are understood',()=>{
 const stream={index:0,codec_type:'video'};
 verifyDecodeDiagnostics('[null] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 1 >= 1',stream,0);
 assert.throws(()=>verifyDecodeDiagnostics('[h264] missing picture in access unit',stream,10),/decode error at 10\.000s/);
});
