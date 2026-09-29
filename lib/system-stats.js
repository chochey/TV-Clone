// Async, shared snapshots keep a slow drive command off the playback event loop.
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
function command(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 3000, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) => resolve({ stdout: stdout || '', ok: !error })));
}
function parseDisks(text) {
  return String(text).trim().split('\n').slice(1).flatMap(line => {
    const m = line.trim().match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
    return m && /^\/(mnt(?:\/|$)|media(?:\/|$)|$)/.test(m[6]) ? [{ source: m[1], total: +m[2], used: +m[3], available: +m[4], percent: +m[5], mount: m[6] }] : [];
  });
}
module.exports = function createSystemStats({ run = command, io = fs.promises, now = Date.now, ttlMs = 10000 } = {}) {
  let prevCpu = null, cached = null, pending = null, gpuIdentity = null;
  function readCpu() {
    const cpus = os.cpus();
    const totals = cpus.reduce((a,c) => { for (const [k,v] of Object.entries(c.times)) { a.total += v; if(k==='idle') a.idle += v; } return a; }, {total:0,idle:0});
    const delta = prevCpu ? totals.total-prevCpu.total : 0;
    const percent = delta > 0 ? Math.round(100*(1-(totals.idle-prevCpu.idle)/delta)) : 0;
    prevCpu=totals;
    return {model:cpus[0]?.model || 'Unknown',cores:cpus.length,percent,loadAvg:os.loadavg()};
  }
  async function refresh() {
    const [disks, identity] = await Promise.all([
      run('df', ['-B1','--output=source,size,used,avail,pcent,target']),
      gpuIdentity || (gpuIdentity = run('lspci', []).then(r => { const v = r.stdout.split('\n').find(l=>/vga/i.test(l)); return v ? v.replace(/^.*:\s*/, '').trim() : null; }).catch(()=>null)),
    ]);
    const parsed = parseDisks(disks.stdout);
    const readFrequency = async name => { for(const card of ['card1','card0']) { try { const n=parseInt(await io.readFile(`/sys/class/drm/${card}/${name}`,'utf8'),10); if(Number.isFinite(n))return n; } catch {} } return null; };
    const [freqMhz,maxFreqMhz]=identity ? await Promise.all([readFrequency('gt_cur_freq_mhz'),readFrequency('gt_max_freq_mhz')]) : [null,null];
    const rows=disks.ok ? parsed : [...(cached?.disks || []).filter(d=>!parsed.some(p=>p.mount===d.mount)),...parsed];
    cached={at:now(),disks:rows.length ? rows : (cached?.disks || []),gpu:identity ? {name:identity,freqMhz,maxFreqMhz} : null,stale:!disks.ok};
    return cached;
  }
  async function snapshot({activeTranscodes=0}={}) {
    if (!cached || now()-cached.at>=ttlMs) {
      if(!pending)pending=refresh().finally(()=>{pending=null;});
      await pending;
    }
    const total=os.totalmem(),free=os.freemem(),used=total-free;
    return {cpu:readCpu(),memory:{total,free,used,percent:Math.round(used/total*100)},disks:cached.disks,gpu:cached.gpu,storageStale:cached.stale,uptime:os.uptime(),activeTranscodes};
  }
  return {snapshot};
};
module.exports.parseDisks=parseDisks;
