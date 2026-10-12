const fs = require('fs');
const {selectAudioTrack,normalizeAudioLanguage,audioTrackTitle} = require('./audio-track-selection');
function allowedCpus() {
  const list = fs.readFileSync('/proc/self/status','utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1] || '0';
  return list.trim().split(',').flatMap(part => {
    const [a,b=a] = part.split('-').map(Number);
    return Array.from({length:b-a+1},(_,i)=>a+i);
  });
}
function cpuList(count) { return allowedCpus().slice(0, Math.max(1, Math.round(count || 2))).join(','); }
function inspectSource(probe) {
  const video = (probe.streams || []).filter(s=>s.codec_type==='video' && !s.disposition?.attached_pic);
  const audio = (probe.streams || []).filter(s=>s.codec_type==='audio');
  if (video.length !== 1 || !audio.length) throw new Error('Needs review: expected one main video and at least one audio track');
  const v = video[0];
  if (['smpte2084','arib-std-b67'].includes(v.color_transfer) || v.color_primaries==='bt2020'
      || (v.side_data_list || []).some(s=>/dovi|dolby|mastering display/i.test(s.side_data_type || ''))) {
    throw new Error('HDR / Dolby Vision needs a separate conversion preset; original untouched');
  }
  if ((probe.streams || []).some(s=>s.codec_type==='subtitle' && !['subrip','ass','ssa','webvtt','mov_text','text'].includes(s.codec_name))) {
    throw new Error('Image subtitles need review; original untouched');
  }
  const primary = selectAudioTrack(audio);
  return {video:v,audio,primary,copyVideo:v.codec_name==='h264' && ['yuv420p','yuvj420p'].includes(v.pix_fmt)};
}
function buildCompatibleArgs(source, output, probe, settings={}) {
  const {video,audio,primary,copyVideo}=inspectSource(probe);
  const copyPrimary = primary.codec_name === 'aac' && primary.channels === 2;
  const extraAudio = audio.filter(track => !copyPrimary || track.index !== primary.index);
  const args=['-v','error','-nostdin','-y','-threads',String(settings.cpuCores || 2),'-i',source,
    '-map',`0:${video.index}`,'-map',`0:${primary.index}`,...extraAudio.flatMap(track=>['-map',`0:${track.index}`]),
    '-map_chapters','-1','-sn','-c:v',copyVideo?'copy':'libx264'];
  if (!copyVideo) args.push('-preset','medium','-crf',String(settings.videoCrf || 20),'-pix_fmt','yuv420p',
    '-vf','scale=trunc(iw/2)*2:trunc(ih/2)*2','-threads:v',String(settings.cpuCores || 2));
  args.push('-c:a:0',copyPrimary?'copy':'aac');
  if (!copyPrimary) args.push('-b:a:0','192k','-ac:a:0','2');
  appendAudioMetadata(args,primary,0,true,!copyPrimary);
  extraAudio.forEach((track,i)=>{
    const index=i+1;
    const copy=['aac','ac3','eac3','mp3','alac'].includes(track.codec_name);
    args.push(`-c:a:${index}`,copy?'copy':'aac');
    appendAudioMetadata(args,track,index,false,false);
    if (!copy) args.push(`-b:a:${index}`,track.channels>2?'384k':'192k');
  });
  args.push('-movflags','+faststart','-progress','pipe:1','-nostats',output);
  return args;
}
function audioLanguage(track) {
  return normalizeAudioLanguage(track.tags?.language) || 'und';
}
function audioTitle(track,browserStereo=false) {
  const title=audioTrackTitle(track);
  return browserStereo ? (title ? `${title} (Browser stereo)` : 'Browser stereo') : title;
}
function appendAudioMetadata(args,track,index,isDefault,browserStereo) {
  // MP4 stores the visible track name as handler_name. Keep title too for
  // containers/tools that expose it, and set language by output audio index.
  const title=audioTitle(track,browserStereo);
  args.push(`-metadata:s:a:${index}`,`language=${audioLanguage(track)}`);
  if(title)args.push(`-metadata:s:a:${index}`,`title=${title}`,`-metadata:s:a:${index}`,`handler_name=${title}`);
  const flags=['dub','original','comment','lyrics','karaoke','forced','hearing_impaired','visual_impaired','clean_effects','non_diegetic','captions','descriptions']
    .filter(flag=>track.disposition?.[flag]);
  if(isDefault)flags.unshift('default');
  args.push(`-disposition:a:${index}`,flags.join('+') || '0');
}
function compatibleStreamPlan(probe) {
  const {video,audio,primary,copyVideo}=inspectSource(probe);
  const copyPrimary=primary.codec_name==='aac' && primary.channels===2;
  const extra=audio.filter(track=>!copyPrimary || track.index!==primary.index);
  return [{type:'video',sourceIndex:video.index,copied:copyVideo},
    {type:'audio',sourceIndex:primary.index,copied:copyPrimary},
    ...extra.map(track=>({type:'audio',sourceIndex:track.index,copied:['aac','ac3','eac3','mp3','alac'].includes(track.codec_name)}))];
}
function verifyCompatibleAudio(source,output) {
  const expected=compatibleStreamPlan(source).filter(track=>track.type==='audio');
  const actual=(output.streams || []).filter(track=>track.codec_type==='audio');
  if(actual.length!==expected.length)throw new Error('Converted audio tracks do not match the source mapping; original retained');
  expected.forEach((row,index)=>{
    const input=source.streams.find(track=>track.index===row.sourceIndex),track=actual[index];
    if(audioLanguage(input)!==audioLanguage(track))throw new Error('Converted audio language metadata changed; original retained');
    if(!!track.disposition?.default!==(index===0))throw new Error('Converted audio default track does not match the preferred language; original retained');
    const title=audioTitle(input,index===0 && !(input.codec_name==='aac' && input.channels===2));
    if(title && title!==audioTrackTitle(track)) {
      throw new Error('Converted audio track titles changed; original retained');
    }
  });
}
module.exports={cpuList,allowedCpus,inspectSource,buildCompatibleArgs,compatibleStreamPlan,verifyCompatibleAudio};
