import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseS124Dataset } from '../../../src/airsea/s124.js';
import { warningStatus } from '../../../src/airsea/warnings.js';
import { airSeaProxy } from './index.js';
import { createWarningService, nwsMarineDrafts } from './warnings.js';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const parse = (name) =>
  parseS124Dataset(read(name), {
    sourceId: 's124-ccg-trial',
    sourceUrl: 'https://nis.ccg-gcc.gc.ca/public/rest/messages/en/s124-trial',
    idPrefix: 's124-ca:',
    fetchedFrom: name,
  });
const T = Date.parse('2026-10-30T12:00:00Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gev-warnings-'));

test('10: S-124 polygon: GML lat lon becomes GeoJSON lon lat, marked TRIAL', () => {
  const { draft } = parse('s124-polygon.gml');
  assert.equal(draft.id, 's124-ca:CCG.S124.CA01.C.3908.26');
  assert.equal(draft.trial, true);
  assert.equal(draft.geometry.type, 'Polygon');
  const [lon, lat] = draft.geometry.coordinates[0][0];
  assert.ok(lon < -70 && lon > -71, `lon ${lon}`);
  assert.ok(lat > 48 && lat < 49, `lat ${lat}`);
  assert.equal(draft.geometryPrecision, 'official');
  assert.match(draft.title, /Offshore Works — Grande-Anse/);
  assert.equal(draft.effectiveFromUtc, '2026-09-08T00:00:00Z');
  assert.equal(draft.effectiveUntilUtc, null, 'open-ended');
  assert.match(draft.originalText, /Drilling operations/);
});

test('10: S-124 point and line stay a point and a line (never buffered)', () => {
  const point = parse('s124-point.gml').draft;
  const pointGeometry =
    point.geometry.type === 'GeometryCollection'
      ? point.geometry.geometries.map((g) => g.type)
      : [point.geometry.type];
  assert.ok(
    pointGeometry.every((type) => type === 'Point'),
    pointGeometry.join(),
  );
  const curve = parse('s124-curve.gml').draft;
  const types =
    curve.geometry.type === 'GeometryCollection'
      ? curve.geometry.geometries.map((g) => g.type)
      : [curve.geometry.type];
  assert.ok(types.includes('LineString'), types.join());
  assert.ok(
    !types.includes('Polygon') || curve.geometryPrecision !== 'approximate',
  );
});

test('10: a stated circle is derived and checked; end dates close the day', () => {
  const circle = parse('s124-circle.gml').draft;
  assert.equal(circle.geometryPrecision, 'derived_checked');
  assert.match(circle.geometryNotes, /stated centre and radius/);
  const ending = parse('s124-dateend.gml').draft;
  assert.equal(ending.effectiveUntilUtc, '2026-11-18T23:59:59Z');
});

test('11: an S-124 cancellation message names the warning it cancels', () => {
  const { draft, cancels } = parse('s124-cancellation.gml');
  assert.ok(draft);
  assert.deepEqual(cancels, ['s124-ca:CCG.S124.CA01.C.3283.24']);
});

test('NWS marine alerts take the official zone outline', () => {
  const alerts = JSON.parse(read('nws-marine-alert.json'));
  const zone = JSON.parse(read('nws-zone-PKZ806.json'));
  const [draft] = nwsMarineDrafts(alerts, (url) =>
    url.endsWith('/PKZ806') ? zone.geometry : null,
  );
  assert.equal(draft.domain, 'marine_weather');
  assert.equal(draft.severity, 'caution', 'Gale Warning');
  assert.equal(draft.geometryPrecision, 'official');
  assert.equal(draft.geometry.type, 'MultiPolygon');
  const [noZone] = nwsMarineDrafts(alerts, () => null);
  assert.equal(noZone.geometry, null, 'no outline loaded: list record only');
  assert.match(noZone.geometryNotes, /not loaded/);
  const cancel = structuredClone(alerts);
  cancel.features[0].properties.messageType = 'Cancel';
  assert.ok(nwsMarineDrafts(cancel, () => null)[0].cancelledAtUtc);
});

test('11: lifecycle in the service: new, changed, cancelled, removed, and history', () => {
  let clock = T;
  const svc = createWarningService({
    dir: tmp(),
    now: () => clock,
    log: () => {},
  });
  const draft = (extra = {}) => ({
    id: 'nws:a',
    sourceId: 'nws-marine',
    domain: 'marine_weather',
    title: 'Gale Warning',
    effectiveFromUtc: new Date(T - 3600_000).toISOString(),
    effectiveUntilUtc: new Date(T + 6 * 3600_000).toISOString(),
    geometry: { type: 'Point', coordinates: [-160, 64] },
    ...extra,
  });
  svc.apply('nws-marine', [draft()], { complete: true, parserVersion: 't' });
  assert.equal(svc.detail('nws:a').lastChange.kind, 'new');
  assert.equal(svc.list()[0].isNew, true);
  clock += 600_000;
  svc.apply('nws-marine', [draft({ title: 'Storm Warning' })], {
    complete: true,
    parserVersion: 't',
  });
  assert.equal(svc.detail('nws:a').lastChange.kind, 'changed');
  // A newer alert supersedes it.
  svc.apply('nws-marine', [draft({ id: 'nws:b', supersedes: ['nws:a'] })], {
    complete: true,
    parserVersion: 't',
  });
  const old = svc.detail('nws:a');
  assert.equal(old.status, 'expired');
  assert.equal(old.endReason, 'superseded');
  assert.deepEqual(
    old.history.map((h) => h.kind),
    ['new', 'changed', 'expired'],
  );
  assert.deepEqual(
    svc.list().map((w) => w.id),
    ['nws:b'],
  );
  assert.equal(svc.list({ includeEnded: true }).length, 2);
});

test('11: a failing feed never ends the warnings it already reported', async () => {
  const dir = tmp();
  let fail = false;
  const svc = createWarningService({
    dir,
    now: () => T,
    log: () => {},
    fetchImpl: async () => {
      if (fail) throw new Error('network down');
      return new Response(
        JSON.stringify({
          type: 'FeatureCollection',
          features: [
            {
              id: 'https://api.weather.gov/alerts/x1',
              geometry: { type: 'Point', coordinates: [-160, 64] },
              properties: {
                id: 'x1',
                event: 'Gale Warning',
                areaDesc: 'Somewhere',
                onset: '2026-10-30T10:00:00Z',
                ends: '2026-10-31T10:00:00Z',
                affectedZones: [],
              },
            },
          ],
        }),
        { status: 200 },
      );
    },
  });
  await svc.pollSource('nws-marine');
  assert.equal(svc.list().length, 1);
  fail = true;
  await svc.pollSource('nws-marine');
  assert.equal(svc.list().length, 1, 'still active');
  const source = svc.sources().find((s) => s.id === 'nws-marine');
  assert.equal(source.status, 'degraded');
  // Restart: the warning is remembered.
  svc.stop();
  const again = createWarningService({ dir, now: () => T, log: () => {} });
  assert.equal(again.list().length, 1);
});

test('unconnected sources are reported honestly and never fetched', async () => {
  const urls = [];
  const svc = createWarningService({
    dir: tmp(),
    now: () => T,
    log: () => {},
    fetchImpl: async (url) => {
      urls.push(String(url));
      throw new Error('offline');
    },
  });
  const byId = Object.fromEntries(svc.sources().map((s) => [s.id, s]));
  assert.equal(byId['faa-notam'].status, 'permission_required');
  assert.equal(byId['airservices-naips'].status, 'permission_required');
  assert.equal(byId['eurocontrol-ead'].status, 'permission_required');
  assert.equal(byId['navarea-coordinators'].status, 'unconfigured');
  await svc.pollSource('nws-marine');
  await svc.pollSource('s124-ccg-trial');
  assert.ok(
    urls.every((u) => /api\.weather\.gov|nis\.ccg-gcc\.gc\.ca/.test(u)),
    urls.join(),
  );
  const withKeys = createWarningService({
    dir: tmp(),
    log: () => {},
    env: { FAA_NOTAM_CLIENT_ID: 'a', FAA_NOTAM_CLIENT_SECRET: 'b' },
  });
  const faa = withKeys.sources().find((s) => s.id === 'faa-notam');
  assert.equal(
    faa.status,
    'unconfigured',
    'credentials alone do not invent a feed',
  );
});

test('routes: list, detail, sources', async () => {
  const svc = createWarningService({ dir: tmp(), now: () => T, log: () => {} });
  svc.apply('s124-ccg-trial', [{ ...parse('s124-polygon.gml').draft }], {
    complete: true,
    parserVersion: 't',
  });
  const plugin = airSeaProxy({ service: { sources: () => [] }, warnings: svc });
  let handler;
  plugin.configureServer({ middlewares: { use: (_p, fn) => (handler = fn) } });
  const call = async (url) => {
    const res = {
      status: 0,
      body: '',
      writeHead(s) {
        res.status = s;
      },
      end(b = '') {
        res.body += b;
      },
    };
    await handler({ method: 'GET', url }, res);
    return { status: res.status, json: JSON.parse(res.body) };
  };
  const list = await call('/warnings');
  assert.equal(list.json.warnings.length, 1);
  assert.equal(list.json.warnings[0].trial, true);
  assert.equal(warningStatus(list.json.warnings[0], T), 'active');
  const id = encodeURIComponent(list.json.warnings[0].id);
  const detail = await call(`/warnings/${id}`);
  assert.match(detail.json.originalText, /Drilling/);
  assert.equal((await call('/warnings/nope')).status, 404);
  assert.ok((await call('/warning-sources')).json.sources.length >= 7);
});

test('one short listing ends nothing; a re-listed warning is reinstated; chains keep one id', () => {
  let clock = T;
  const svc = createWarningService({
    dir: tmp(),
    now: () => clock,
    log: () => {},
  });
  const draft = (extra = {}) => ({
    id: 'nws:a',
    sourceId: 'nws-marine',
    domain: 'marine_weather',
    title: 'Gale Warning',
    effectiveFromUtc: new Date(T - 3600_000).toISOString(),
    effectiveUntilUtc: new Date(T + 6 * 3600_000).toISOString(),
    geometry: { type: 'Point', coordinates: [-160, 64] },
    ...extra,
  });
  const listing = (drafts) =>
    svc.apply('nws-marine', drafts, { complete: true, parserVersion: 't' });
  listing([draft()]);
  // One empty answer: still in force.
  listing([]);
  assert.deepEqual(
    svc.list().map((w) => w.id),
    ['nws:a'],
  );
  // Two in a row: ended. Listed again afterwards: reinstated.
  listing([]);
  assert.equal(svc.list().length, 0);
  listing([draft()]);
  const back = svc.detail('nws:a');
  assert.equal(back.status, 'active');
  assert.equal(back.endReason, null);
  assert.equal(back.lastChange.kind, 'reinstated');
  // NWS reissues the alert under a new id: one chain.
  clock += 600_000;
  listing([draft({ id: 'nws:b', supersedes: ['nws:a'] })]);
  clock += 600_000;
  listing([draft({ id: 'nws:c', supersedes: ['nws:b'] })]);
  assert.equal(svc.list()[0].chainId, 'nws:a');
});

test('an NWS Cancel message cancels what it references and is no warning itself', () => {
  const svc = createWarningService({ dir: tmp(), now: () => T, log: () => {} });
  const alerts = (features) => ({ type: 'FeatureCollection', features });
  const feature = (id, extra = {}) => ({
    id: `https://api.weather.gov/alerts/${id}`,
    geometry: { type: 'Point', coordinates: [-160, 64] },
    properties: {
      id,
      event: 'Gale Warning',
      areaDesc: 'Somewhere',
      onset: '2026-10-30T10:00:00Z',
      ends: '2026-10-31T10:00:00Z',
      affectedZones: [],
      ...extra,
    },
  });
  const drafts = nwsMarineDrafts(
    alerts([
      feature('A'),
      feature('B', {
        messageType: 'Cancel',
        references: [{ identifier: 'A' }],
      }),
    ]),
    () => null,
  );
  svc.apply(
    'nws-marine',
    drafts.filter((d) => !d.cancel),
    {
      complete: true,
      cancels: drafts.filter((d) => d.cancel).flatMap((d) => d.supersedes),
      parserVersion: 't',
    },
  );
  assert.equal(svc.detail('nws:A').status, 'cancelled');
  assert.equal(svc.detail('nws:B'), null);
});


// --- shared outlines on disk and in memory --------------------------------
// A zone-like polygon: a closed ring of `n` positions around (lon, lat).
const zonePolygon = (lon, lat, n = 400) => {
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    ring.push([
      +(lon + 0.5 * Math.cos(a)).toFixed(6),
      +(lat + 0.3 * Math.sin(a)).toFixed(6),
    ]);
  }
  ring.push([...ring[0]]);
  return [ring];
};
const zoneDraft = (id, polygons, extra = {}) => ({
  id,
  sourceId: 'nws-marine',
  domain: 'marine_weather',
  title: `Small Craft Advisory ${id}`,
  effectiveFromUtc: new Date(T - 3600_000).toISOString(),
  effectiveUntilUtc: new Date(T + 6 * 3600_000).toISOString(),
  geometry: { type: 'MultiPolygon', coordinates: polygons },
  geometryPrecision: 'official',
  ...extra,
});
const STORE = 'warnings.v2.json';
const LEGACY = 'warnings.json';
const readSaved = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, STORE), 'utf8'));
const byId = (list) => Object.fromEntries(list.map((w) => [w.id, w]));
const OPTS = { complete: true, parserVersion: 't' };

test('warnings that share zones hold one outline each in memory, and on disk', () => {
  const dir = tmp();
  const svc = createWarningService({ dir, now: () => T, log: () => {} });
  const a = zonePolygon(-159.5, 22.4);
  const b = zonePolygon(-158.2, 21.6);
  const c = zonePolygon(-156.9, 20.9);
  // Three updates over the same two zones (as NWS issues them), each a fresh
  // copy as parsed from the feed, and one more sharing a zone and adding one.
  svc.apply(
    'nws-marine',
    [
      zoneDraft('nws:1', [a, b]),
      zoneDraft('nws:2', structuredClone([a, b])),
      zoneDraft('nws:3', structuredClone([a, b])),
      zoneDraft('nws:4', structuredClone([b, c])),
    ],
    OPTS,
  );
  // In memory, before any save: this is what keeps the server's heap small.
  assert.equal(svc.storedOutlines(), 3);
  const live = byId(svc.list());
  assert.equal(
    live['nws:1'].geometry.coordinates[0],
    live['nws:3'].geometry.coordinates[0],
    'one array, not a copy per warning',
  );
  assert.equal(
    live['nws:1'].geometry.coordinates[1],
    live['nws:4'].geometry.coordinates[0],
  );
  assert.throws(
    () => live['nws:1'].geometry.coordinates[0][0].push([0, 0]),
    TypeError,
  );
  assert.throws(() => {
    live['nws:2'].geometry.coordinates[0][0][0][0] = 0;
  }, TypeError);

  const before = svc.list();
  svc.stop();
  const saved = readSaved(dir);
  assert.equal(saved.version, 2);
  assert.equal(Object.keys(saved.parts).length, 3, 'one copy per zone');
  assert.equal(fs.existsSync(path.join(dir, LEGACY)), false);
  const fileBytes = fs.statSync(path.join(dir, STORE)).size;
  const inlineBytes = JSON.stringify(before.map((w) => w.geometry)).length;
  assert.ok(
    fileBytes < inlineBytes / 2,
    `shared form ${fileBytes} B vs ${inlineBytes} B of inline outlines`,
  );

  const again = createWarningService({ dir, now: () => T, log: () => {} });
  assert.deepEqual(byId(again.list()), byId(before), 'the same warnings');
  assert.equal(again.storedOutlines(), 3);
  const w = byId(again.list());
  assert.equal(
    w['nws:1'].geometry.coordinates[0],
    w['nws:2'].geometry.coordinates[0],
  );
  assert.equal(again.detail('nws:4').geometry.coordinates.length, 2);
});

test('every geometry type comes back the same, through two saves', () => {
  const dir = tmp();
  const svc = createWarningService({ dir, now: () => T, log: () => {} });
  const line = [
    [-150, 60],
    [-149.5, 60.2],
    [-149, 60.1],
  ];
  const hole = [
    [
      [-140, 58],
      [-139, 58],
      [-139, 59],
      [-140, 59],
      [-140, 58],
    ],
    [
      [-139.8, 58.2],
      [-139.2, 58.2],
      [-139.2, 58.8],
      [-139.8, 58.2],
    ],
  ];
  const geometries = {
    'g:point': { type: 'Point', coordinates: [-160, 64] },
    'g:points': {
      type: 'MultiPoint',
      coordinates: [
        [-160, 64],
        [-161, 65],
      ],
    },
    'g:line': { type: 'LineString', coordinates: line },
    'g:lines': {
      type: 'MultiLineString',
      coordinates: [structuredClone(line), [[-148, 59], [-147, 59.5]]],
    },
    'g:hole': { type: 'Polygon', coordinates: hole },
    'g:nested': {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [-150, 61] },
        { type: 'LineString', coordinates: structuredClone(line) },
        { type: 'Polygon', coordinates: structuredClone(hole) },
      ],
    },
    'g:none': null,
  };
  svc.apply(
    'nws-marine',
    Object.entries(geometries).map(([id, geometry]) =>
      zoneDraft(id, [], { geometry }),
    ),
    OPTS,
  );
  const before = svc.list();
  assert.equal(before.length, 7);
  // The line is one part whether alone, in a MultiLineString or nested.
  const w = byId(before);
  assert.equal(w['g:line'].geometry.coordinates, w['g:lines'].geometry.coordinates[0]);
  assert.equal(
    w['g:line'].geometry.coordinates,
    w['g:nested'].geometry.geometries[1].coordinates,
  );
  svc.stop();
  const second = createWarningService({ dir, now: () => T, log: () => {} });
  assert.deepEqual(byId(second.list()), byId(before));
  second.apply('nws-marine', [zoneDraft('g:extra', [zonePolygon(0, 0)])], OPTS);
  second.stop();
  const third = createWarningService({ dir, now: () => T, log: () => {} });
  const after = byId(third.list());
  for (const id of Object.keys(geometries))
    assert.deepEqual(after[id], w[id], id);
});

test('an older warnings.json is read once and left as it was, for a rollback', () => {
  const dir = tmp();
  const svc = createWarningService({ dir, now: () => T, log: () => {} });
  const a = zonePolygon(-70.5, 48.4);
  svc.apply(
    'nws-marine',
    [
      zoneDraft('nws:1', [a]),
      zoneDraft('nws:2', structuredClone([a])),
      zoneDraft('nws:3', [], {
        geometry: { type: 'Point', coordinates: [-160, 64] },
      }),
    ],
    OPTS,
  );
  const before = svc.list();
  svc.stop();
  // Make the older form: every outline inline, in warnings.json, as the
  // code before this change wrote it; and no shared-form file yet.
  const v2 = readSaved(dir);
  const inline = (g) =>
    g?.refs
      ? { type: g.type, coordinates: g.refs.map((r) => v2.parts[r]) }
      : g?.ref
        ? { type: g.type, coordinates: v2.parts[g.ref] }
        : g;
  const legacyText = JSON.stringify({
    version: 1,
    records: v2.records.map((r) => ({ ...r, geometry: inline(r.geometry) })),
    sources: v2.sources,
  });
  fs.writeFileSync(path.join(dir, LEGACY), legacyText);
  fs.rmSync(path.join(dir, STORE));

  const old = createWarningService({ dir, now: () => T, log: () => {} });
  assert.deepEqual(byId(old.list()), byId(before));
  assert.equal(old.storedOutlines(), 1);
  old.stop(); // nothing new arrived, but the shared form is written
  assert.equal(readSaved(dir).version, 2);
  assert.equal(Object.keys(readSaved(dir).parts).length, 1);
  assert.equal(
    fs.readFileSync(path.join(dir, LEGACY), 'utf8'),
    legacyText,
    'the older file is never written: code rolled back still reads it',
  );
  // From now on the shared form is what loads.
  const third = createWarningService({ dir, now: () => T, log: () => {} });
  assert.deepEqual(byId(third.list()), byId(before));
});

test('outlines of pruned warnings are let go, in memory and on disk', () => {
  const dir = tmp();
  let clock = T;
  const svc = createWarningService({ dir, now: () => clock, log: () => {} });
  const kept = zonePolygon(-150, 60);
  const gone = zonePolygon(-140, 58);
  svc.apply(
    'nws-marine',
    [zoneDraft('nws:kept', [kept]), zoneDraft('nws:gone', [gone])],
    OPTS,
  );
  svc.stop();
  assert.equal(svc.storedOutlines(), 2);
  // Left out of two complete listings: ended; 31 days on: pruned.
  svc.apply('nws-marine', [zoneDraft('nws:kept', [kept])], OPTS);
  svc.apply('nws-marine', [zoneDraft('nws:kept', [kept])], OPTS);
  assert.equal(svc.detail('nws:gone').endReason, 'removed_by_source');
  clock += 31 * 24 * 3600_000;
  svc.apply(
    'nws-marine',
    [
      zoneDraft('nws:kept', [kept], {
        effectiveUntilUtc: new Date(clock + 3600_000).toISOString(),
      }),
    ],
    OPTS,
  );
  assert.equal(svc.detail('nws:gone'), null, 'pruned');
  svc.stop();
  assert.equal(svc.storedOutlines(), 1, 'its outline left memory too');
  const saved = readSaved(dir);
  assert.equal(Object.keys(saved.parts).length, 1);
  assert.deepEqual(
    saved.records.map((r) => r.id),
    ['nws:kept'],
  );
});

test('a save that fails, or would be too large to read back, keeps the last good file', () => {
  const dir = tmp();
  const logs = [];
  const svc = createWarningService({
    dir,
    now: () => T,
    log: (m) => logs.push(m),
  });
  svc.apply('nws-marine', [zoneDraft('nws:1', [zonePolygon(-150, 60)])], OPTS);
  svc.stop();
  const good = fs.readFileSync(path.join(dir, STORE), 'utf8');
  // The temporary file's name is taken by a folder: the write fails.
  fs.mkdirSync(path.join(dir, `${STORE}.tmp`));
  svc.apply(
    'nws-marine',
    [
      zoneDraft('nws:1', [zonePolygon(-150, 60)]),
      zoneDraft('nws:2', [zonePolygon(-140, 58)]),
    ],
    OPTS,
  );
  svc.stop();
  assert.match(logs.join('\n'), /could not save warnings/);
  assert.equal(fs.readFileSync(path.join(dir, STORE), 'utf8'), good);
  assert.equal(svc.storedOutlines(), 2, 'nothing let go after a failed save');
  fs.rmdirSync(path.join(dir, `${STORE}.tmp`));
  svc.stop(); // nothing new since, but the failed save is owed
  assert.deepEqual(
    readSaved(dir)
      .records.map((r) => r.id)
      .sort(),
    ['nws:1', 'nws:2'],
  );

  // A file past the size that can be read back is never written.
  const small = tmp();
  const smallLogs = [];
  const limited = createWarningService({
    dir: small,
    now: () => T,
    log: (m) => smallLogs.push(m),
    maxSavedChars: 20_000,
  });
  limited.apply('nws-marine', [zoneDraft('nws:1', [zonePolygon(1, 1, 50)])], OPTS);
  limited.stop();
  const fits = fs.readFileSync(path.join(small, STORE), 'utf8');
  limited.apply(
    'nws-marine',
    [
      zoneDraft('nws:1', [zonePolygon(1, 1, 50)]),
      zoneDraft('nws:big', [zonePolygon(2, 2, 2000)]),
    ],
    OPTS,
  );
  limited.stop();
  assert.match(smallLogs.join('\n'), /too large to read back/);
  assert.equal(fs.readFileSync(path.join(small, STORE), 'utf8'), fits);
  assert.equal(fs.existsSync(path.join(small, `${STORE}.tmp`)), false);
});

test('a bad record or a missing outline costs only itself', () => {
  const dir = tmp();
  const svc = createWarningService({ dir, now: () => T, log: () => {} });
  svc.apply(
    'nws-marine',
    [
      zoneDraft('nws:ok', [zonePolygon(-150, 60)]),
      zoneDraft('nws:lost', [zonePolygon(-140, 58)]),
    ],
    OPTS,
  );
  svc.stop();
  const saved = readSaved(dir);
  // One record's outline part goes missing; another record is unreadable.
  const lost = saved.records.find((r) => r.id === 'nws:lost');
  delete saved.parts[lost.geometry.refs[0]];
  saved.records.push({
    id: 'nws:broken',
    sourceId: 'nws-marine',
    geometry: { type: 'Polygon' },
  });
  saved.records.push({
    id: 'nws:after',
    ...structuredClone(saved.records[0]),
  });
  saved.records.at(-1).id = 'nws:after';
  fs.writeFileSync(path.join(dir, STORE), JSON.stringify(saved));

  const logs = [];
  const again = createWarningService({
    dir,
    now: () => T,
    log: (m) => logs.push(m),
  });
  assert.ok(again.detail('nws:ok'));
  assert.ok(again.detail('nws:after'), 'records after a bad one still load');
  assert.equal(again.detail('nws:broken'), null);
  const l = again.detail('nws:lost');
  assert.equal(l.geometry, null);
  assert.equal(l.bounds, null, 'no box drawn from an outline that is gone');
  assert.equal(l.geometryPrecision, 'none');
  assert.match(logs.join('\n'), /1 unreadable record\(s\) skipped, 1 outline\(s\) missing/);
});

test('an unreadable saved file is set aside, never overwritten, and reported', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, STORE), '{"version":2,"rec');
  const logs = [];
  const svc = createWarningService({
    dir,
    now: () => T,
    log: (m) => logs.push(m),
  });
  assert.equal(svc.list().length, 0);
  assert.match(logs.join('\n'), /could not read saved warnings/);
  const aside = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(`${STORE}.unreadable-`));
  assert.equal(aside.length, 1);
  assert.equal(
    fs.readFileSync(path.join(dir, aside[0]), 'utf8'),
    '{"version":2,"rec',
  );
  const quiet = [];
  createWarningService({ dir: tmp(), now: () => T, log: (m) => quiet.push(m) });
  assert.deepEqual(quiet, [], 'a first run (no file) is not an error');
});
