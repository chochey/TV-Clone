// The Docker containers (VPN, qBittorrent, Cloudflare tunnel) only update when someone pulls, and
// nobody had since February. A weekly job pulls, switches only when nothing plays or downloads,
// proves each switch worked (VPN up, downloads still leave through it, the app still sees
// qBittorrent, the tunnel connected) and otherwise rolls back.
const test = require('node:test');
const assert = require('node:assert/strict');
const createContainerUpdates = require('./container-updates');
const { quietCheck } = createContainerUpdates;

const MIN = 60000;
// A pretend Docker: images by tag, what each container runs, and how a given image behaves.
function fakeDocker({ available = {}, behaviour = {}, previous = {} } = {}) {
  const tags = { ...previous, 'qmcgaw/gluetun:v3': 'g-old', 'lscr.io/linuxserver/qbittorrent:latest': 'q-old', 'cloudflare/cloudflared:latest': 'c-old' };
  const created = { 'g-old': '2026-02-11T00:00:00Z', 'q-old': '2026-02-03T00:00:00Z', 'c-old': '2026-10-26T00:00:00Z',
    'g-new': '2026-10-25T00:00:00Z', 'q-new': '2026-10-24T00:00:00Z', 'c-new': '2026-10-27T00:00:00Z', 'q-older': '2025-12-01T00:00:00Z' };
  const containers = { gluetun: { ref: 'qmcgaw/gluetun:v3', id: 'g-old' }, qbittorrent: { ref: 'lscr.io/linuxserver/qbittorrent:latest', id: 'q-old' },
    cloudflared: { ref: 'cloudflare/cloudflared:latest', id: 'c-old' } };
  const calls = [];
  const how = id => ({ healthy: true, exitIp: '10.8.0.1', webui: 200, appSees: true, tunnel: 4, ...(behaviour[id] || {}) });
  async function run(cmd, args) {
    calls.push([cmd, ...args].join(' '));
    const a = args.join(' ');
    if (cmd === 'docker' && a.startsWith('compose ps')) return { code: 0, stdout: 'cloudflared\tcloudflared\ngluetun\tgluetun\nqbittorrent\tqbittorrent\n' };
    if (cmd === 'docker' && a === 'compose pull') { Object.assign(tags, available); return { code: 0, stdout: '' }; }
    if (cmd === 'docker' && args[0] === 'inspect') {
      const c = containers[args[1]]; const h = how(c.id);
      return { code: 0, stdout: `${c.ref}\t${c.id}\t${args[1] === 'gluetun' ? (h.healthy ? 'healthy' : 'unhealthy') : ''}\t${c.stopped ? 'false' : 'true'}` };
    }
    if (cmd === 'docker' && args[0] === 'image' && args[1] === 'inspect') {
      const id = tags[args[2]] || args[2];
      return created[id] ? { code: 0, stdout: `${id}\t${created[id]}` } : { code: 1, stdout: '', stderr: `No such image: ${args[2]}` };
    }
    if (cmd === 'docker' && args[0] === 'image' && args[1] === 'rm') return { code: 0, stdout: '' };
    if (cmd === 'docker' && args.slice(0, 4).join(' ') === 'compose up -d --force-recreate') {
      for (const s of args.slice(4)) { containers[s].id = tags[containers[s].ref]; containers[s].stopped = false; }
      return { code: 0, stdout: '' };
    }
    if (cmd === 'docker' && args[0] === 'tag') { tags[args[2]] = args[1]; return { code: 0, stdout: '' }; }
    if (cmd === 'docker' && args[0] === 'stop') { containers[args[1]].stopped = true; return { code: 0, stdout: '' }; }
    if (cmd === 'docker' && args[0] === 'exec') return { code: 0, stdout: containers.qbittorrent.stopped ? '' : how(containers.qbittorrent.id).exitIp };
    if (cmd === 'docker' && args[0] === 'image' && args[1] === 'prune') return { code: 0, stdout: '' };
    if (cmd === 'curl' && a.includes('api.ipify.org')) return { code: 0, stdout: '68.40.46.38' };
    if (cmd === 'curl' && a.includes(':8080')) return { code: 0, stdout: String(how(containers.qbittorrent.id).webui) };
    if (cmd === 'curl' && a.includes('/metrics')) return { code: 0, stdout: `cloudflared_tunnel_ha_connections ${how(containers.cloudflared.id).tunnel}\n` };
    throw new Error(`unexpected command: ${cmd} ${a}`);
  }
  // The app rewrites its download file on every poll that reaches qBittorrent.
  const readinessAt = () => (!containers.qbittorrent.stopped && how(containers.qbittorrent.id).appSees ? Date.now() + 1 : 0);
  return { run, calls, containers, tags, readinessAt };
}

function updater(d, { quiet = [true], statusOut = [] } = {}) {
  let q = 0;
  return createContainerUpdates({
    run: d.run, composeDir: '/stack', readinessUpdatedAt: d.readinessAt,
    isQuiet: async () => { const v = quiet[Math.min(q++, quiet.length - 1)]; return { quiet: v, reason: v ? '' : 'a film is playing' }; },
    writeStatus: s => statusOut.push(s), sleep: async () => {}, log() {},
    timeouts: { health: 50, tunnel: 50, integration: 50, poll: 1 }, busyPollMs: 1, waitBudgetMs: 10,
  });
}
const recreated = d => d.calls.filter(c => c.startsWith('docker compose up -d --force-recreate')).map(c => c.replace('docker compose up -d --force-recreate ', ''));

test('nothing new: nothing is restarted, and the status lists each image and when it was built', async () => {
  const d = fakeDocker(), out = [];
  const r = await updater(d, { statusOut: out }).update();
  assert.equal(r.result, 'current');
  assert.deepEqual(recreated(d), []);
  assert.deepEqual(out.at(-1).containers.map(c => [c.name, c.builtAt.slice(0, 10), c.updated]),
    [['cloudflared', '2026-10-26', false], ['gluetun', '2026-02-11', false], ['qbittorrent', '2026-02-03', false]]);
});

test('a new qBittorrent that works is kept: only it restarts, and its old build date is recorded', async () => {
  const d = fakeDocker({ available: { 'lscr.io/linuxserver/qbittorrent:latest': 'q-new' } }), out = [];
  const r = await updater(d, { statusOut: out }).update();
  assert.equal(r.result, 'updated');
  assert.deepEqual(recreated(d), ['qbittorrent']);
  const q = out.at(-1).containers.find(c => c.name === 'qbittorrent');
  assert.deepEqual([q.updated, q.healthy, q.builtAt.slice(0, 10), q.previousBuiltAt.slice(0, 10)], [true, true, '2026-10-24', '2026-02-03']);
});

test('the replaced version is kept under a "chochey-previous" tag, and the one before it is removed', async () => {
  const d = fakeDocker({ available: { 'lscr.io/linuxserver/qbittorrent:latest': 'q-new' },
    previous: { 'lscr.io/linuxserver/qbittorrent:chochey-previous': 'q-older' } });
  await updater(d).update();
  assert.ok(d.calls.includes('docker tag q-old lscr.io/linuxserver/qbittorrent:chochey-previous'));
  assert.ok(d.calls.includes('docker image rm q-older'));
  assert.equal(d.calls.filter(c => c.startsWith('docker image rm')).length, 1, 'nothing else is removed');
});

test('if someone starts watching while the new versions download, nothing switches and the tags go back', async () => {
  const d = fakeDocker({ available: { 'lscr.io/linuxserver/qbittorrent:latest': 'q-new' } });
  const r = await updater(d, { quiet: [true, false] }).update();
  assert.equal(r.result, 'busy');
  assert.deepEqual(recreated(d), []);
  assert.equal(d.tags['lscr.io/linuxserver/qbittorrent:latest'], 'q-old');
});

test('a new VPN restarts qBittorrent with it, since qBittorrent uses the VPN\'s connection', async () => {
  const d = fakeDocker({ available: { 'qmcgaw/gluetun:v3': 'g-new' } });
  const r = await updater(d).update();
  assert.equal(r.result, 'updated');
  assert.deepEqual(recreated(d), ['gluetun qbittorrent']);
});

test('downloads leaving without the VPN: qBittorrent is stopped at once and both are rolled back', async () => {
  const d = fakeDocker({ available: { 'qmcgaw/gluetun:v3': 'g-new' }, behaviour: { 'q-old': {}, 'g-new': {} } });
  // With the new VPN image, qBittorrent's traffic shows the home address.
  const realRun = d.run;
  d.run = async (cmd, args) => (cmd === 'docker' && args[0] === 'exec' && d.containers.gluetun.id === 'g-new' && !d.containers.qbittorrent.stopped)
    ? { code: 0, stdout: '68.40.46.38' } : realRun(cmd, args);
  const out = [];
  const r = await updater(d, { statusOut: out }).update();
  assert.equal(r.result, 'rolled-back');
  const stopAt = d.calls.indexOf('docker stop qbittorrent'), rollbackAt = d.calls.findIndex(c => c.startsWith('docker tag g-old'));
  assert.ok(stopAt >= 0 && stopAt < rollbackAt, 'stopped before anything else');
  assert.deepEqual([d.containers.gluetun.id, d.containers.qbittorrent.id], ['g-old', 'q-old']);
  assert.equal(out.at(-1).containers.find(c => c.name === 'gluetun').error, 'VPN_LEAK');
  assert.equal(d.containers.qbittorrent.stopped, false, 'running again on the old, working pair');
});

test('if the app can no longer see qBittorrent after an update, the old version is put back', async () => {
  const d = fakeDocker({ available: { 'lscr.io/linuxserver/qbittorrent:latest': 'q-new' }, behaviour: { 'q-new': { appSees: false } } }), out = [];
  const r = await updater(d, { statusOut: out }).update();
  assert.equal(r.result, 'rolled-back');
  assert.equal(d.containers.qbittorrent.id, 'q-old');
  assert.equal(out.at(-1).containers.find(c => c.name === 'qbittorrent').error, 'APP_LOST_QBITTORRENT');
});

test('a tunnel that does not reconnect is rolled back too', async () => {
  const d = fakeDocker({ available: { 'cloudflare/cloudflared:latest': 'c-new' }, behaviour: { 'c-new': { tunnel: 0 } } });
  const r = await updater(d).update();
  assert.equal(r.result, 'rolled-back');
  assert.equal(d.containers.cloudflared.id, 'c-old');
});

test('while something plays or downloads nothing is pulled; with wait it tries again later', async () => {
  const busy = fakeDocker();
  assert.equal((await updater(busy, { quiet: [false] }).update()).result, 'busy');
  assert.equal(busy.calls.some(c => c === 'docker compose pull'), false);
  const later = fakeDocker({ available: { 'lscr.io/linuxserver/qbittorrent:latest': 'q-new' } });
  assert.equal((await updater(later, { quiet: [false, false, true] }).update({ wait: true })).result, 'updated');
});

test('status alone reads the build dates without pulling or restarting anything', async () => {
  const d = fakeDocker(), out = [];
  await updater(d, { statusOut: out }).status();
  assert.equal(d.calls.some(c => c.includes('pull') || c.includes('force-recreate')), false);
  assert.equal(out.at(-1).result, 'checked');
  assert.equal(out.at(-1).containers.length, 3);
});

// What counts as busy, read from the files the app already writes.
function quietFiles({ playedMinAgo = 120, states = ['stoppedUP'], readinessMinAgo = 0.1 } = {}) {
  const now = Date.parse('2026-10-27T04:30:00Z');
  const files = {
    'profile_a.json': { progress: { x: { updatedAt: now - 600 * MIN } } },
    'profile_b.json': { progress: { y: { updatedAt: now - playedMinAgo * MIN } } },
    'download-readiness.json': { updatedAt: now - readinessMinAgo * MIN, entries: states.map(state => ({ names: ['t'], ready: false, state })) },
  };
  return { dataDir: '/data', now: () => now, readdir: async () => Object.keys(files), readJSON: async f => files[f.replace('/data/', '')] };
}

test('quiet means nobody played anything for 30 minutes and no torrent is downloading', async () => {
  assert.deepEqual(await quietCheck(quietFiles()), { quiet: true, reason: '' });
  const played = await quietCheck(quietFiles({ playedMinAgo: 12 }));
  assert.equal(played.quiet, false); assert.match(played.reason, /played 12 min ago/);
  const dl = await quietCheck(quietFiles({ states: ['stoppedUP', 'downloading', 'metaDL'] }));
  assert.equal(dl.quiet, false); assert.match(dl.reason, /2 downloads/);
  // Seeding, stalled or queued torrents are not moving files around, so they do not hold the update.
  assert.equal((await quietCheck(quietFiles({ states: ['uploading', 'stalledDL', 'queuedDL'] }))).quiet, true);
});

test('when the app has not heard from qBittorrent lately, nothing is updated (the check afterwards could not prove anything)', async () => {
  const r = await quietCheck(quietFiles({ readinessMinAgo: 9 }));
  assert.equal(r.quiet, false); assert.match(r.reason, /9 min/);
});
