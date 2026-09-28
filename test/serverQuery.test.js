// Homepage player counts from the servers themselves (a2s.js, serverQuery.js).
// No network and no SSH: the query and the config reader are replaced.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseInfo } = require('../a2s');
const sq = require('../serverQuery');

const quiet = { warn: console.warn };
console.warn = () => {};
test.after(() => Object.assign(console, quiet));

const VOL1 = '97c0c03d-3b26-47a7-989a-e7389ed14d6b';
const VOL2 = '604e8905-50b2-4cdc-8aa7-cae8a7528c24';

test('an A2S_INFO reply is read: name, players, max', () => {
  const reply = Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17]),
    Buffer.from('[EU1] Test\0Map\0folder\0game\0', 'utf8'),
    Buffer.from([0x00, 0x00, 80, 100, 0]),
  ]);
  assert.deepEqual(parseInfo(reply), { name: '[EU1] Test', map: 'Map', players: 80, maxPlayers: 100, bots: 0 });
});

test('a challenge or a short packet is never taken for an answer', () => {
  assert.throws(() => parseInfo(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41, 1, 2, 3, 4])));
  assert.throws(() => parseInfo(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17, 0x41])));
});

test('the volume in a server path is the panel uuid', () => {
  const v = sq._test.volumeUuidFromPath(`/var/lib/pterodactyl/volumes/${VOL1.toUpperCase()}/config.json`);
  assert.equal(v, VOL1);
  assert.equal(sq._test.volumeUuidFromPath('/somewhere/else/config.json'), null);
});

test('query ports come from each config.json, keyed by volume; bad ones are left out', () => {
  const servers = [
    { id: 'eu1', configPath: `/var/lib/pterodactyl/volumes/${VOL1}/config.json` },
    { id: 'eu2', configPath: `/var/lib/pterodactyl/volumes/${VOL2}/config.json` },
    { id: 'na1', configPath: '/var/lib/pterodactyl/volumes/eb373584-c050-4155-935a-5ccc8b3e760e/config.json' },
  ];
  const ports = sq._test.portsFromConfigs(servers, {
    eu1: { a2s: { port: 17778 } },
    eu2: { a2s: { port: 'nope' } },
    // na1 could not be read
  });
  assert.deepEqual([...ports.entries()], [[VOL1, 17778]]);
});

test('a count is asked of the right host and port; a failure is no number', async () => {
  sq._test.setPorts([[VOL1, 17778]]);
  let asked = null;
  const ok = await sq.playerCount(VOL1.toUpperCase(), '217.182.194.180', {
    query: async (host, port) => { asked = [host, port]; return { players: 67, maxPlayers: 100 }; },
  });
  assert.deepEqual(asked, ['217.182.194.180', 17778]);
  assert.deepEqual(ok, { players: 67, max: 100 });
  assert.equal(await sq.playerCount(VOL1, '217.182.194.180', { query: async () => { throw new Error('a2s_timeout'); } }), null);
  assert.equal(await sq.playerCount(VOL2, '217.182.194.180', { query: async () => ({ players: 1, maxPlayers: 2 }) }), null);
  assert.equal(await sq.playerCount(VOL1, null, { query: async () => ({ players: 1, maxPlayers: 2 }) }), null);
});

test('ports are read once an hour, and a failed read is retried after five minutes, not every poll', async () => {
  sq._test.reset();
  let reads = 0;
  const failing = async () => { reads += 1; throw new Error('ssh down'); };
  const t0 = 1_000_000_000_000;
  await sq.queryPorts({ now: t0, readConfigs: failing });
  await sq.queryPorts({ now: t0 + 30_000, readConfigs: failing });
  assert.equal(reads, 1);
  await sq.queryPorts({ now: t0 + 6 * 60_000, readConfigs: failing });
  assert.equal(reads, 2);
});
