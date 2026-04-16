// CPU/memory/disk/GPU snapshot for the admin dashboard.
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

module.exports = function createSystemStats() {
  let prevCpu = null;

  function readCpu() {
    const cpus = os.cpus();
    const cpuModel = cpus[0]?.model || 'Unknown';
    const cpuCores = cpus.length;
    const totals = cpus.reduce((acc, c) => {
      acc.user += c.times.user; acc.nice += c.times.nice;
      acc.sys += c.times.sys; acc.idle += c.times.idle;
      acc.irq += c.times.irq;
      return acc;
    }, { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 });
    const total = totals.user + totals.nice + totals.sys + totals.idle + totals.irq;
    const idle = totals.idle;
    let percent = 0;
    if (prevCpu) {
      const dTotal = total - prevCpu.total;
      const dIdle = idle - prevCpu.idle;
      percent = dTotal > 0 ? Math.round(((dTotal - dIdle) / dTotal) * 100) : 0;
    }
    prevCpu = { total, idle };
    return { model: cpuModel, cores: cpuCores, percent, loadAvg: os.loadavg() };
  }

  function readMem() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    return { total, used, free, percent: Math.round((used / total) * 100) };
  }

  function readDisks() {
    const disks = [];
    try {
      let dfOut;
      try {
        dfOut = execFileSync('df', ['-B1', '--output=source,size,used,avail,pcent,target'], { timeout: 5000, encoding: 'utf-8' });
      } catch (e) {
        dfOut = e.stdout || ''; // df may exit 1 on stale mounts but still print output
      }
      const lines = dfOut.trim().split('\n').slice(1);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 6 && /^\/(mnt|media|$)/.test(parts[5])) {
          disks.push({
            mount: parts.slice(5).join(' '), source: parts[0],
            total: parseInt(parts[1]) || 0, used: parseInt(parts[2]) || 0,
            available: parseInt(parts[3]) || 0, percent: parseInt(parts[4]) || 0,
          });
        }
      }
    } catch {}
    return disks;
  }

  function readGpu() {
    try {
      const lspci = execFileSync('lspci', [], { timeout: 5000, encoding: 'utf-8' });
      const vga = lspci.split('\n').find(l => /vga/i.test(l));
      const gpuName = vga ? vga.replace(/^.*:\s*/, '').trim() : null;
      if (!gpuName) return null;
      let freq = null, maxFreq = null;
      for (const card of ['card1', 'card0']) {
        if (freq === null) {
          try { freq = parseInt(fs.readFileSync(`/sys/class/drm/${card}/gt_cur_freq_mhz`, 'utf-8').trim()); } catch {}
        }
        if (maxFreq === null) {
          try { maxFreq = parseInt(fs.readFileSync(`/sys/class/drm/${card}/gt_max_freq_mhz`, 'utf-8').trim()); } catch {}
        }
      }
      return { name: gpuName, freqMhz: freq, maxFreqMhz: maxFreq };
    } catch { return null; }
  }

  function snapshot({ activeTranscodes = 0 } = {}) {
    return {
      cpu: readCpu(),
      memory: readMem(),
      disks: readDisks(),
      gpu: readGpu(),
      uptime: os.uptime(),
      activeTranscodes,
    };
  }

  return { snapshot };
};
