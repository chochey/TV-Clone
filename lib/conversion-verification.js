// Streamed packet inventory: no full-file packet JSON or unbounded stderr buffer.
const TOLERANCE_SECONDS = 1;
function number(value) { const n = Number(value); return value !== '' && value !== 'N/A' && Number.isFinite(n) ? n : null; }
function declaredDuration(stream) {
  const numeric = number(stream.duration);
  if (numeric > 0) return numeric;
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(String(stream.tags?.DURATION || stream.tags?.duration || '').trim());
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}
function frameDuration(stream) {
  const [a,b] = String(stream.avg_frame_rate || stream.r_frame_rate || '').split('/').map(Number);
  return a > 0 && b > 0 ? b/a : 0;
}
function createPacketCollector(probe) {
  const streams = new Map((probe.streams || []).map(s => [s.index, {
    index:s.index, type:s.codec_type, packets:0, min:Infinity, max:-Infinity,
    lastDts:null, backwards:0, missingTimestamps:0, maxDuration:0, deltaTotal:0, deltaCount:0,
    fallbackDuration:frameDuration(s),
  }]));
  let pending = '', warnings = '', warningBytes = 0;
  function line(text) {
    if (!text.trim()) return;
    const packet = Object.fromEntries(text.trim().split('|').map(field => {
      const i=field.indexOf('='); return [field.slice(0,i),field.slice(i+1)];
    }));
    const stream = streams.get(Number(packet.stream_index));
    if (!stream) return;
    const pts=number(packet.pts_time), dts=number(packet.dts_time), duration=number(packet.duration_time);
    const timestamp=pts ?? dts;
    stream.packets++;
    if (timestamp === null) { stream.missingTimestamps++; return; }
    stream.min=Math.min(stream.min,timestamp);
    stream.max=Math.max(stream.max,timestamp + Math.max(0,duration || 0));
    stream.maxDuration=Math.max(stream.maxDuration,duration || 0);
    if (dts !== null && stream.lastDts !== null) {
      const delta=dts-stream.lastDts;
      if (delta < -0.002) stream.backwards++;
      if (delta > 0) { stream.deltaTotal+=delta; stream.deltaCount++; }
    }
    if(dts !== null)stream.lastDts=dts;
  }
  return {
    write(chunk) {
      pending+=String(chunk);
      let i; while((i=pending.indexOf('\n'))>=0) { line(pending.slice(0,i)); pending=pending.slice(i+1); }
      if(pending.length>65536)throw new Error('Packet inventory returned an invalid oversized line');
    },
    warn(chunk) { warningBytes+=Buffer.byteLength(chunk); if(warnings.length<4096)warnings+=String(chunk).slice(0,4096-warnings.length); },
    finish() {
      if(pending)line(pending);
      return {warnings: warnings.trim(), warningBytes, streams:[...streams.values()].map(s=>{
        const estimated=s.maxDuration || s.fallbackDuration || (s.deltaCount ? s.deltaTotal/s.deltaCount : 0);
        const end=s.maxDuration ? s.max : s.max+estimated;
        return {...s,end,duration:end-s.min};
      })};
    },
  };
}
function summary(stream) { return `${stream.type} track ${stream.index}: packets ${stream.packets}, span ${stream.duration.toFixed(3)}s`; }
function review(reason) { return new Error(`Needs review: ${reason}; original retained`); }
function validateSourcePackets(probe, inventory) {
  const media=inventory.streams.filter(s=>s.type==='video'||s.type==='audio');
  if(inventory.warningBytes)throw review(`source packet parser reported ${inventory.warningBytes} bytes of warnings/errors (${inventory.warnings.split('\n').find(Boolean) || 'unknown parser warning'}); declared container ${probe.format?.duration || 'unknown'}s; measured ${media.map(summary).join(', ')}`);
  for(const stream of media) {
    // Attached pictures are not main video and are deliberately not converted.
    if(probe.streams.find(s=>s.index===stream.index)?.disposition?.attached_pic)continue;
    if(!stream.packets || !Number.isFinite(stream.duration) || stream.duration<=0 || stream.missingTimestamps || stream.backwards) {
      throw review(`source timestamp/packet inconsistency (${summary(stream)}, missing timestamps ${stream.missingTimestamps}, backwards DTS ${stream.backwards})`);
    }
    const declared=declaredDuration(probe.streams.find(s=>s.index===stream.index));
    if(declared && Math.abs(declared-stream.duration)>TOLERANCE_SECONDS)throw review(`source declared ${stream.type} duration ${declared.toFixed(3)}s differs from measured ${stream.duration.toFixed(3)}s`);
  }
  // Container duration includes subtitles. Measure all packet types before
  // comparing it when media lacks per-stream duration; never trust a shortened
  // source solely because conversion preserved its already-truncated packets.
  if(media.some(s=>!declaredDuration(probe.streams.find(t=>t.index===s.index)))) {
    const declared=number(probe.format?.duration);
    const populated=inventory.streams.filter(s=>s.packets && Number.isFinite(s.end));
    const start=number(probe.format?.start_time) ?? Math.min(...populated.map(s=>s.min));
    const measured=Math.max(...populated.map(s=>s.end))-start;
    if(!declared || !Number.isFinite(measured) || Math.abs(declared-measured)>TOLERANCE_SECONDS) {
      throw review(`source container duration ${declared === null ? 'unknown' : declared.toFixed(3)}s differs from measured packet extent ${measured.toFixed(3)}s`);
    }
  }
  return Math.max(...media.filter(s=>s.packets).map(s=>s.end))-Math.min(...media.filter(s=>s.packets).map(s=>s.min));
}
function verifyPacketPreservation(sourceInventory, outputInventory, plan, outputProbe) {
  if(outputInventory.warningBytes)throw new Error(`Converted packet parser reported warnings/errors: ${outputInventory.warnings.split('\n').find(Boolean)}`);
  const outputStreams=outputProbe.streams.filter(s=>s.codec_type==='video'||s.codec_type==='audio');
  if(outputStreams.length!==plan.length)throw new Error(`Converted stream count ${outputStreams.length} does not match expected ${plan.length}`);
  const sourceVideo=sourceInventory.streams.find(s=>s.index===plan.find(s=>s.type==='video').sourceIndex);
  const outputVideo=outputInventory.streams.find(s=>s.index===outputStreams.find(s=>s.codec_type==='video').index);
  return plan.map((expected,i)=>{
    const actual=outputStreams[i], source=sourceInventory.streams.find(s=>s.index===expected.sourceIndex);
    const output=outputInventory.streams.find(s=>s.index===actual.index);
    if(actual.codec_type!==expected.type || !output?.packets || !Number.isFinite(output.duration) || output.duration<=0 || output.missingTimestamps || output.backwards) {
      throw new Error(`Converted ${expected.type} track ${actual.index} has missing media or inconsistent timestamps`);
    }
    const delta=Math.abs(source.duration-output.duration);
    if(delta>TOLERANCE_SECONDS)throw new Error(`Converted ${expected.type} track ${actual.index} duration does not match source track ${source.index}: measured source ${source.duration.toFixed(3)}s, output ${output.duration.toFixed(3)}s`);
    if(Math.abs((source.min-sourceVideo.min)-(output.min-outputVideo.min))>TOLERANCE_SECONDS)throw new Error(`Converted ${expected.type} track ${actual.index} start offset does not match source track ${source.index}`);
    if(expected.copied && source.packets!==output.packets)throw new Error(`Converted copied ${expected.type} track ${actual.index} lost packets: source ${source.packets}, output ${output.packets}`);
    return {stream:actual,packets:output};
  });
}
function verifyDecodedSample(stdout, stream, seek, sampleDuration) {
  const field=stream.codec_type==='video'?'frame':'out_time_us';
  const values=[...String(stdout).matchAll(new RegExp(`(?:^|\\n)${field}=(\\d+)`, 'g'))].map(m=>Number(m[1]));
  const decoded=Math.max(0,...values);
  // Audio timestamps have been reset to sample count / sample rate.
  const samples=stream.codec_type==='audio'?Math.round(decoded*Number(stream.sample_rate)/1e6):decoded;
  if(!samples)throw new Error(`Converted ${stream.codec_type} track ${stream.index} decoded no ${stream.codec_type==='audio'?'samples':'frames'} at ${seek.toFixed(3)}s`);
  if(stream.codec_type==='video') {
    const frameSeconds=frameDuration(stream);
    const minimum=frameSeconds ? Math.max(1,Math.floor(sampleDuration/frameSeconds*0.9)-1) : 1;
    if(decoded<minimum)throw new Error(`Converted video track ${stream.index} decoded only ${decoded} frames at ${seek.toFixed(3)}s; expected at least ${minimum}`);
  }
  if(stream.codec_type==='audio' && decoded/1e6 < sampleDuration-0.25)throw new Error(`Converted audio track ${stream.index} decoded only ${(decoded/1e6).toFixed(3)}s of requested ${sampleDuration.toFixed(3)}s at ${seek.toFixed(3)}s`);
  return samples;
}
function verifyDecodeDiagnostics(stderr,stream,seek) {
  // The null muxer may complain about reordered DTS despite decoding all
  // frames. That specific muxer message is unrelated to decoder integrity.
  const errors=String(stderr).split('\n').filter(line=>line.trim() && !/Application provided invalid, non monotonically increasing dts to muxer/.test(line));
  if(errors.length)throw new Error(`Converted ${stream.codec_type} track ${stream.index} decode error at ${seek.toFixed(3)}s: ${errors[0]}`);
}
module.exports={createPacketCollector,validateSourcePackets,verifyPacketPreservation,verifyDecodedSample,verifyDecodeDiagnostics,declaredDuration,TOLERANCE_SECONDS};
