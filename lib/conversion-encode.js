const fs = require('fs');
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
  const primary = audio.find(s=>s.disposition?.default) || audio[0];
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
  args.push('-disposition:a:0','default',
    '-metadata:s:a:0','title=Browser stereo');
  extraAudio.forEach((track,i)=>{
    const index=i+1;
    const copy=['aac','ac3','eac3','mp3','alac'].includes(track.codec_name);
    args.push(`-c:a:${index}`,copy?'copy':'aac',`-disposition:a:${index}`,'0');
    if (!copy) args.push(`-b:a:${index}`,track.channels>2?'384k':'192k');
  });
  args.push('-movflags','+faststart','-progress','pipe:1','-nostats',output);
  return args;
}
module.exports={cpuList,allowedCpus,inspectSource,buildCompatibleArgs};
