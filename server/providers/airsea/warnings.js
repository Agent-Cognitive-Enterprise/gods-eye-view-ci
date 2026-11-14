// Warning areas service (fork feature): connectors for the structured,
// legally usable warning feeds, lifecycle tracking with history, and an
// honest catalogue of the sources that are not connected (permission,
// terms or no machine-readable feed). Nothing here scrapes a web page.

import fs from 'node:fs';
import path from 'node:path';
import {
  parseS124Dataset,
  S124_PARSER_VERSION,
} from '../../../src/airsea/s124.js';
import {
  NEW_WARNING_MS,
  changeKind,
  geometryBounds,
  normalizeWarning,
  stableHash,
  warningStatus,
} from '../../../src/airsea/warnings.js';
import { readZipTextEntries } from './zip.js';
import { createGeometryStore } from './geometryStore.js';
import { readResponseBytesCapped } from '../../../src/sources/httpBody.js';

const USER_AGENT = 'GodsEyeView-fork/early-warning (local research instance)';
const NWS_PARSER_VERSION = 'nws-marine-1';
const HISTORY_PER_WARNING = 20;
const RETAIN_ENDED_MS = 30 * 24 * 3600_000;
const ZONE_TTL_MS = 14 * 24 * 3600_000;
// Zone outlines fetched per poll (two at a time); the rest follow next poll.
const ZONES_PER_POLL = 120;

/**
 * Every warning source considered, connected or not. `access` says what the
 * source offers: machine_readable, trial, human_readable or
 * permission_required. Unconnected sources are never fetched.
 */
export const WARNING_SOURCES = Object.freeze([
  Object.freeze({
    id: 'nws-marine',
    short: 'NWS marine',
    domain: 'marine_weather',
    title: 'US National Weather Service marine alerts',
    access: 'machine_readable',
    connected: true,
    coverage:
      'US coastal, offshore and Great Lakes marine forecast zones (zone outlines from api.weather.gov)',
    url: 'https://www.weather.gov/documentation/services-web-alerts',
    licence: 'US Government work (public domain)',
    limitations: [
      'Marine weather alerts, not navigational warnings or exclusion orders',
      'Areas are whole forecast zones; the alert may affect part of a zone',
    ],
  }),
  Object.freeze({
    id: 's124-ccg-trial',
    short: 'CCG S-124',
    domain: 'maritime',
    title: 'Canadian Coast Guard S-124 trial exchange set',
    access: 'trial',
    connected: true,
    coverage:
      'Canadian waters in the trial set (St. Lawrence, Great Lakes, Arctic)',
    url: 'https://nis.ccg-gcc.gc.ca/public/rest/messages/en/s124-trial',
    licence: 'Government of Canada; trial data, not operational or official',
    limitations: [
      'TEST DATA: never used for alerts',
      'Weekly exchange set; dates carry no time zone',
    ],
  }),
  Object.freeze({
    id: 'faa-notam',
    short: 'FAA NOTAM',
    domain: 'aviation',
    title: 'FAA NOTAM API',
    access: 'permission_required',
    connected: false,
    coverage: 'US airspace and US-issued international NOTAMs',
    url: 'https://aa.data.faa.gov/data/',
    licence: 'FAA data agreement required',
    limitations: ['Automated access needs an approved FAA data agreement'],
  }),
  Object.freeze({
    id: 'eurocontrol-ead',
    short: 'EAD',
    domain: 'aviation',
    title: 'EUROCONTROL European AIS Database',
    access: 'permission_required',
    connected: false,
    coverage: 'European NOTAMs',
    url: 'https://www.eurocontrol.int/service/european-ais-database',
    licence: 'Automated access needs an agreement; EAD Basic is for viewing',
    limitations: ['Not scraped'],
  }),
  Object.freeze({
    id: 'airservices-naips',
    short: 'NAIPS',
    domain: 'aviation',
    title: 'Airservices Australia NAIPS',
    access: 'permission_required',
    connected: false,
    coverage: 'Australian NOTAMs',
    url: 'https://www.airservices.gov.au/naips/Account/LogOn',
    licence:
      'Terms prohibit bots, scripts, scrapers and AI tools without prior written authorisation',
    limitations: ['Needs written authorisation from Airservices'],
  }),
  Object.freeze({
    id: 'amsa-navarea-x',
    short: 'AMSA',
    domain: 'maritime',
    title: 'AMSA maritime safety information (NAVAREA X)',
    access: 'permission_required',
    connected: false,
    coverage: 'NAVAREA X (Australia)',
    url: 'https://www.amsa.gov.au/safety-navigation/navigation-systems/maritime-safety-information-database',
    licence: 'Public pages; no bulk or API licence verified',
    limitations: ['Not fetched until terms or permission are confirmed'],
  }),
  Object.freeze({
    id: 'navarea-coordinators',
    short: 'NAVAREA',
    domain: 'maritime',
    title: 'Other NAVAREA coordinators (IHO directory)',
    access: 'human_readable',
    connected: false,
    coverage: 'Worldwide, uneven; some areas publish nothing online',
    url: 'https://iho.int/navigation-warnings-on-the-web',
    licence: 'Varies by coordinator; no scraping rights assumed',
    limitations: ['No unified machine-readable feed'],
  }),
]);

const NWS_SEVERITY = [
  [/hurricane|storm warning|special marine|tsunami|typhoon/i, 'danger'],
  [/gale|hazardous seas|heavy freezing spray|warning/i, 'caution'],
  [/advisory|statement|watch|outlook/i, 'advisory'],
];

/** NWS marine alerts (GeoJSON) → drafts; geometry from the alert or its zones. */
export function nwsMarineDrafts(collection, zoneGeometry) {
  const drafts = [];
  for (const feature of collection?.features ?? []) {
    const p = feature?.properties ?? {};
    if (!p.id) continue;
    let geometry = feature.geometry ?? null;
    let precision = geometry ? 'official' : 'none';
    let notes = null;
    if (!geometry) {
      const polygons = [];
      let missing = 0;
      for (const zone of p.affectedZones ?? []) {
        const g = zoneGeometry(zone);
        if (g?.type === 'Polygon') polygons.push(g.coordinates);
        else if (g?.type === 'MultiPolygon') polygons.push(...g.coordinates);
        else missing += 1;
      }
      if (polygons.length) {
        geometry = { type: 'MultiPolygon', coordinates: polygons };
        precision = 'official';
        notes = 'NWS forecast zone outlines';
      }
      if (missing)
        notes = [notes, `${missing} zone outline(s) not loaded yet`]
          .filter(Boolean)
          .join('; ');
    }
    const event = String(p.event ?? 'Marine alert');
    drafts.push({
      id: `nws:${p.id}`,
      sourceId: 'nws-marine',
      originalId: p.id,
      domain: 'marine_weather',
      warningType: event.toLowerCase().replace(/\s+/g, '_'),
      authority: p.senderName ?? 'National Weather Service',
      title: `${event} — ${String(p.areaDesc ?? '').split(';')[0]}`,
      originalText: [p.headline, p.description, p.instruction]
        .filter(Boolean)
        .join('\n\n'),
      sourceUrl: typeof feature.id === 'string' ? feature.id : p['@id'],
      publishedAtUtc: p.sent ?? null,
      effectiveFromUtc: p.onset ?? p.effective ?? null,
      effectiveUntilUtc: p.ends ?? p.expires ?? null,
      cancel: p.messageType === 'Cancel',
      cancelledAtUtc: p.messageType === 'Cancel' ? (p.sent ?? null) : null,
      severity: NWS_SEVERITY.find(([re]) => re.test(event))?.[1] ?? 'advisory',
      geometry,
      geometryPrecision: precision,
      geometryNotes: notes,
      supersedes: (p.references ?? []).map((r) => `nws:${r.identifier}`),
      fetchedFrom: 'https://api.weather.gov/alerts/active?region_type=marine',
    });
  }
  return drafts;
}

function nwsZoneId(url) {
  return /\/zones\/\w+\/([A-Z]{2}Z\d{3})$/.exec(String(url ?? ''))?.[1] ?? null;
}

/**
 * @param {{dir: string, fetchImpl?: Function, now?: () => number,
 *   log?: Function, env?: object, maxSavedBytes?: number,
 *   readRetries?: number, readFile?: (file: string) => string}} options
 */
export function createWarningService({
  dir,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  log = (...args) => console.warn(...args),
  env = process.env,
  // Above this a saved file could no longer be read back: readFileSync
  // fails past V8's longest string, which it measures in bytes.
  maxSavedBytes = 400 * 1024 * 1024,
  // A file another program holds for a moment (a virus scanner) is read
  // again this many times, waiting longer each time, before saving pauses.
  readRetries = 3,
  readFile = (f) => fs.readFileSync(f, 'utf8'),
}) {
  // Shared outlines go to their own file, so older code (which cannot read
  // them) never meets one: rolled back, it finds its own warnings.json as
  // it last wrote it. This code reads that file, never writes it.
  const STORE = 'warnings.v2.json';
  const file = path.join(dir, STORE);
  const legacyFile = path.join(dir, 'warnings.json');
  const zoneDir = path.join(dir, 'zones');
  const records = new Map(); // id -> stored record
  const state = {}; // source id -> {last_success_at, last_attempt_at, last_error, failures, validators, count}
  const zones = new Map(); // zone id -> {geometry, fetchedAt}
  // Outlines are shared between records (see geometryStore.js).
  const geometries = createGeometryStore();
  let dirty = false;
  let version = 0; // bumped by every apply: list answers are cached by it
  const timers = [];
  // A saved file that exists but could not be read is never written over:
  // saving pauses until it reads (tried again at every save) or the server
  // restarts, and the pause is logged hourly and shown in sources().
  let blockedSource = null;
  let blockedReason = null;
  let lastSaveFailure = { message: null, at: -Infinity };

  const modified = (f) => {
    try {
      return fs.statSync(f).mtimeMs;
    } catch {
      return null;
    }
  };

  /**
   * The saved files to try, best first; none to start empty. The older form
   * comes first only when it was written after the shared one (older code
   * ran during a rollback and saved what it saw); if it is then damaged,
   * the shared file is next.
   */
  function candidates() {
    const shared = modified(file);
    const older = modified(legacyFile);
    if (shared !== null)
      return older !== null && older > shared ? [legacyFile, file] : [file];
    // A shared file that was set aside as unreadable means the older file is
    // out of date: reading it would bring back warnings that have ended
    // since. (A leftover .tmp proves nothing: that save never finished.)
    let setAside = false;
    try {
      setAside = fs
        .readdirSync(dir)
        .some((n) => n.startsWith(`${STORE}.unreadable-`));
    } catch {
      // no folder yet: a first run
    }
    if (setAside) {
      if (older !== null)
        log(
          `[airsea] ${STORE} was set aside as unreadable; the older warnings.json is out of date and not used`,
        );
      return [];
    }
    return older !== null ? [legacyFile] : [];
  }

  const pause = (ms) =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  /**
   * {saved} or {error, damaged}. Damaged is a file that will never read
   * (bad JSON, too long, not a warnings file); anything else (a file held
   * by another program) is read again, waiting longer each time.
   */
  function readSaved(source, retries = readRetries) {
    for (let attempt = 0; ; attempt++) {
      try {
        const saved = JSON.parse(readFile(source));
        if (!saved || typeof saved !== 'object' || Array.isArray(saved))
          return { error: new Error('not a warnings file'), damaged: true };
        return { saved };
      } catch (error) {
        const damaged =
          error instanceof SyntaxError || error?.code === 'ERR_STRING_TOO_LONG';
        if (damaged || attempt >= retries) return { error, damaged };
        pause(250 * 2 ** attempt);
      }
    }
  }

  /**
   * Records from a saved file. With `keepCurrent`, records already held
   * (newer than the file) stay as they are; only missing ones are added.
   */
  function ingest(saved, { keepCurrent = false } = {}) {
    let added = 0;
    let skipped = 0;
    let outlinesLost = 0;
    for (const record of Array.isArray(saved.records) ? saved.records : []) {
      // One bad record is skipped; it never costs the rest of the file.
      try {
        if (!record?.id) throw new Error('no id');
        if (keepCurrent && records.has(record.id)) continue;
        const had = record.geometry != null;
        // Version 1 carries every outline inline; version 2 keeps each
        // shared part once, in `parts`.
        record.geometry = geometries.decode(record.geometry, saved.parts);
        if (had && !record.geometry) {
          // Said honestly: no outline, and no box drawn from the old one.
          record.bounds = null;
          record.geometryPrecision = 'none';
          record.geometryNotes = 'outline lost on load';
          outlinesLost += 1;
        }
        records.set(record.id, record);
        added += 1;
      } catch {
        skipped += 1;
      }
    }
    if (saved.sources && typeof saved.sources === 'object')
      for (const [id, s] of Object.entries(saved.sources))
        if (!keepCurrent || !(id in state)) state[id] = s;
    if (skipped || outlinesLost)
      log(
        `[airsea] saved warnings: ${skipped} unreadable record(s) skipped, ${outlinesLost} outline(s) missing`,
      );
    return added;
  }

  /** Handle a file that did not read; true when loading may go on. */
  function unreadable(source, { error, damaged }) {
    const name = path.basename(source);
    log(`[airsea] could not read saved warnings (${name}): ${error?.message}`);
    if (damaged && source === file)
      try {
        // Kept for the operator rather than overwritten by the next save.
        fs.renameSync(file, `${file}.unreadable-${now()}`);
        return true;
      } catch {
        // cannot be moved: treated as held
      }
    else if (damaged) return true; // the older form: simply not used
    blockedSource = source;
    blockedReason = `${name} could not be read (${error?.message})`;
    log(
      `[airsea] ${name} is left as it is; warnings are not saved until it can be read`,
    );
    return false;
  }

  function load() {
    for (const source of candidates()) {
      const result = readSaved(source);
      if (result.saved) {
        ingest(result.saved);
        // The older form is written out in the shared form at the next save.
        if (source === legacyFile && records.size) dirty = true;
        return;
      }
      if (!unreadable(source, result)) return;
    }
    // nothing to read: a first run, or only damaged files; the feeds refill it
  }
  load();

  /** Try the held file again; true when saving may go on. */
  function retryBlocked() {
    const source = blockedSource;
    const result = readSaved(source, 0);
    if (result.saved) {
      blockedSource = null;
      blockedReason = null;
      const added = ingest(result.saved, { keepCurrent: true });
      log(
        `[airsea] ${path.basename(source)} could be read again: ${added} saved warning(s) added; saving resumes`,
      );
      return true;
    }
    if (!result.damaged) return false;
    blockedSource = null;
    blockedReason = null;
    return unreadable(source, result);
  }

  /** Write all of `bytes`, however many calls the file system needs. */
  function writeAll(fd, bytes) {
    let at = 0;
    while (at < bytes.length) {
      const n = fs.writeSync(fd, bytes, at);
      if (n <= 0) throw new Error('the disk accepted nothing');
      at += n;
    }
  }

  /** One line per kind of failure, and again at most hourly while it lasts. */
  function saveFailed(message) {
    const t = now();
    if (
      message === lastSaveFailure.message &&
      t - lastSaveFailure.at < 3600_000
    )
      return;
    lastSaveFailure = { message, at: t };
    log(`[airsea] could not save warnings: ${message}`);
  }

  // Written piece by piece: the file never has to fit in one string.
  function save() {
    if (!dirty) return;
    if (blockedSource && !retryBlocked()) {
      saveFailed(`saves paused: ${blockedReason}`);
      return; // still owed
    }
    dirty = false;
    const tmp = `${file}.tmp`;
    let fd = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const used = new Set();
      const stored = [...records.values()].map((record) => ({
        ...record,
        geometry: geometries.encode(record.geometry, used),
      }));
      fd = fs.openSync(tmp, 'w');
      let chunk = '';
      let size = 0;
      const flush = () => {
        const bytes = Buffer.from(chunk, 'utf8');
        size += bytes.length;
        if (size > maxSavedBytes)
          throw new Error('too large to read back; the last good file is kept');
        writeAll(fd, bytes);
        chunk = '';
      };
      const write = (text) => {
        chunk += text;
        if (chunk.length >= 1 << 20) flush();
      };
      write(`{"version":2,"sources":${JSON.stringify(state)},"parts":{`);
      let first = true;
      for (const key of used) {
        write(
          `${first ? '' : ','}${JSON.stringify(key)}:${JSON.stringify(geometries.part(key))}`,
        );
        first = false;
      }
      write('},"records":[');
      stored.forEach((record, i) =>
        write(`${i ? ',' : ''}${JSON.stringify(record)}`),
      );
      write(']}');
      flush();
      fs.fsyncSync(fd); // on disk before it replaces the last good file
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, file);
      lastSaveFailure = { message: null, at: -Infinity };
      // Parts no record uses any more (pruned warnings) are let go.
      geometries.keepOnly(used);
    } catch (error) {
      if (fd !== null)
        try {
          fs.closeSync(fd);
        } catch {
          // already closed
        }
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // replaced by the next save
      }
      dirty = true; // tried again at the next save
      saveFailed(error.message);
    }
  }

  const iso = (ms) => new Date(ms).toISOString();

  /** Store a batch from one source; ends what the source no longer lists. */
  function apply(sourceId, drafts, { complete, cancels = [], parserVersion }) {
    const t = now();
    const seen = new Set();
    for (const draft of drafts) {
      const next = normalizeWarning(draft, {
        receivedAtUtc: iso(t),
        parserVersion,
      });
      if (!next) continue;
      seen.add(next.id);
      const previous = records.get(next.id);
      let kind = changeKind(previous, next, t);
      // Listed again after a listing that left it out: still in force.
      const reinstated = previous?.endReason === 'removed_by_source';
      if (reinstated && !kind) kind = 'reinstated';
      // One chain id across updates that supersede each other (NWS issues
      // every update under a new id): the Autopilot follows the chain.
      const chainId =
        previous?.chainId ??
        next.supersedes
          .map((id) => records.get(id)?.chainId ?? null)
          .find(Boolean) ??
        next.supersedes.find((id) => records.has(id)) ??
        next.id;
      const stored = {
        ...next,
        // The same zones recur in every update: one shared copy each.
        geometry: geometries.intern(next.geometry),
        bounds: geometryBounds(next.geometry),
        chainId,
        firstSeenAtUtc: previous?.firstSeenAtUtc ?? iso(t),
        lastVerifiedAtUtc: iso(t),
        missingListings: 0,
        // An earlier end or cancellation recorded here is kept, except an
        // absence the source has now taken back.
        cancelledAtUtc: next.cancelledAtUtc ?? previous?.cancelledAtUtc ?? null,
        endedAtUtc: reinstated ? null : (previous?.endedAtUtc ?? null),
        endReason: reinstated ? null : (previous?.endReason ?? null),
        lastChange: kind
          ? { kind, atUtc: iso(t) }
          : (previous?.lastChange ?? null),
        history: [
          ...(previous?.history ?? []),
          ...(kind
            ? [{ atUtc: iso(t), kind, contentHash: next.contentHash }]
            : []),
        ].slice(-HISTORY_PER_WARNING),
      };
      records.set(next.id, stored);
      if (kind) dirty = true;
      for (const older of next.supersedes) end(older, 'superseded', t);
    }
    for (const id of cancels) {
      const record = records.get(id);
      if (record && !record.cancelledAtUtc) {
        record.cancelledAtUtc = iso(t);
        note(record, 'cancelled', t);
      }
    }
    // A complete, successful listing is authoritative: anything of this
    // source it no longer contains has ended (never because a feed failed).
    // Two listings in a row must leave it out, so one short or empty answer
    // cannot end every warning at once.
    if (complete)
      for (const record of records.values()) {
        if (record.sourceId !== sourceId || seen.has(record.id)) continue;
        if (record.endedAtUtc || record.cancelledAtUtc) continue;
        record.missingListings = (record.missingListings ?? 0) + 1;
        dirty = true;
        if (record.missingListings >= 2) end(record.id, 'removed_by_source', t);
      }
    version += 1;
    prune(t);
  }

  function note(record, kind, t) {
    record.lastChange = { kind, atUtc: iso(t) };
    record.history = [...(record.history ?? []), { atUtc: iso(t), kind }].slice(
      -HISTORY_PER_WARNING,
    );
    dirty = true;
  }

  function end(id, reason, t) {
    const record = records.get(id);
    if (!record || record.endedAtUtc || record.cancelledAtUtc) return;
    record.endedAtUtc = iso(t);
    record.endReason = reason;
    note(record, 'expired', t);
  }

  function prune(t) {
    for (const [id, record] of records) {
      const status = warningStatus(record, t);
      if (status !== 'expired' && status !== 'cancelled') continue;
      const endedAt = Date.parse(
        record.endedAtUtc ??
          record.cancelledAtUtc ??
          record.effectiveUntilUtc ??
          '',
      );
      if (Number.isFinite(endedAt) && t - endedAt > RETAIN_ENDED_MS) {
        records.delete(id);
        dirty = true;
      }
    }
  }

  async function get(url, { accept, validators, timeoutMs = 60_000 } = {}) {
    const response = await fetchImpl(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: accept ?? '*/*',
        ...(validators?.etag ? { 'If-None-Match': validators.etag } : {}),
        ...(validators?.lastModified
          ? { 'If-Modified-Since': validators.lastModified }
          : {}),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response;
  }

  // --- zone outlines (cached on disk for two weeks) -----------------------
  /** A zone outline from memory or the disk cache, or null. */
  function cachedZone(id) {
    if (!zones.has(id)) {
      try {
        zones.set(
          id,
          JSON.parse(fs.readFileSync(path.join(zoneDir, `${id}.json`), 'utf8')),
        );
      } catch {
        return null;
      }
    }
    return zones.get(id);
  }

  function zoneGeometry(url) {
    const id = nwsZoneId(url);
    return id ? (cachedZone(id)?.geometry ?? null) : null;
  }

  async function loadZones(urls) {
    const t = now();
    const byId = new Map();
    for (const url of urls) {
      const id = nwsZoneId(url);
      if (id && !byId.has(id)) byId.set(id, url);
    }
    const wanted = [...byId]
      .map(([id, url]) => ({ id, url }))
      .filter(({ id }) => {
        const cached = cachedZone(id);
        return !cached || t - cached.fetchedAt > ZONE_TTL_MS;
      })
      .slice(0, ZONES_PER_POLL);
    // Two at a time: a polite pace for api.weather.gov.
    for (let i = 0; i < wanted.length; i += 2) {
      await Promise.all(
        wanted.slice(i, i + 2).map(async ({ url, id }) => {
          if (!/^https:\/\/api\.weather\.gov\/zones\//.test(url)) return;
          try {
            const response = await get(url, {
              accept: 'application/geo+json',
              timeoutMs: 20_000,
            });
            if (!response.ok) return;
            const body = await response.json();
            if (!body?.geometry) return;
            const entry = { geometry: body.geometry, fetchedAt: t };
            zones.set(id, entry);
            fs.mkdirSync(zoneDir, { recursive: true });
            fs.writeFileSync(
              path.join(zoneDir, `${id}.json`),
              JSON.stringify(entry),
            );
          } catch {
            // retried next poll
          }
        }),
      );
    }
  }

  // --- connectors ---------------------------------------------------------
  const connectors = {
    'nws-marine': {
      intervalMs: 10 * 60_000,
      async poll() {
        const response = await get(
          'https://api.weather.gov/alerts/active?region_type=marine',
          {
            accept: 'application/geo+json',
          },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const collection = await response.json();
        await loadZones(
          (collection.features ?? []).flatMap(
            (f) => f.properties?.affectedZones ?? [],
          ),
        );
        const drafts = nwsMarineDrafts(collection, zoneGeometry);
        // A Cancel message cancels the alerts it references; it is not a
        // warning of its own.
        apply(
          'nws-marine',
          drafts.filter((d) => !d.cancel),
          {
            complete: true,
            cancels: drafts
              .filter((d) => d.cancel)
              .flatMap((d) => d.supersedes),
            parserVersion: NWS_PARSER_VERSION,
          },
        );
        return (collection.features ?? []).length;
      },
    },
    's124-ccg-trial': {
      intervalMs: 12 * 3600_000,
      async poll() {
        const url =
          'https://nis.ccg-gcc.gc.ca/notice/s124/Canada_S100_Exchange_Set.zip';
        const response = await get(url, {
          accept: 'application/zip',
          validators: state['s124-ccg-trial']?.validators,
        });
        if (response.status === 304) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // Capped while read, with or without a declared length.
        const bytes = Buffer.from(
          await readResponseBytesCapped(response, 32 * 1024 * 1024),
        );
        const entries = readZipTextEntries(bytes, {
          accept: (n) => /DATASET_FILES\/[^/]+\.GML$/i.test(n),
        });
        const drafts = [];
        const cancels = [];
        for (const { name, text } of entries) {
          const parsed = parseS124Dataset(text, {
            sourceId: 's124-ccg-trial',
            sourceUrl:
              'https://nis.ccg-gcc.gc.ca/public/rest/messages/en/s124-trial',
            idPrefix: 's124-ca:',
            fetchedFrom: `${url}#${name}`,
          });
          if (parsed.draft) {
            parsed.draft.sourceHash = stableHash(text);
            drafts.push(parsed.draft);
          }
          cancels.push(...parsed.cancels);
        }
        apply('s124-ccg-trial', drafts, {
          complete: true,
          cancels,
          parserVersion: S124_PARSER_VERSION,
        });
        state['s124-ccg-trial'].validators = {
          etag: response.headers.get('etag'),
          lastModified: response.headers.get('last-modified'),
        };
        return drafts.length;
      },
    },
  };

  async function pollSource(id) {
    const connector = connectors[id];
    const s = (state[id] ??= { failures: 0 });
    s.last_attempt_at = now();
    try {
      const count = await connector.poll();
      s.last_success_at = now();
      s.last_error = null;
      s.failures = 0;
      if (count !== null) s.count = count;
    } catch (error) {
      s.failures = (s.failures ?? 0) + 1;
      s.last_error = String(error?.message ?? error).slice(0, 200);
      log(`[airsea] ${id} poll failed: ${s.last_error}`);
    }
    dirty = true;
    save();
  }

  function sourceStatus(source) {
    if (
      source.id === 'faa-notam' &&
      env.FAA_NOTAM_CLIENT_ID &&
      env.FAA_NOTAM_CLIENT_SECRET
    )
      return { status: 'unconfigured', reason: 'adapter_awaiting_api_details' };
    if (!source.connected)
      return {
        status:
          source.access === 'permission_required'
            ? 'permission_required'
            : 'unconfigured',
        reason: source.access,
      };
    const s = state[source.id] ?? {};
    const interval = connectors[source.id].intervalMs;
    if (!s.last_success_at)
      return {
        status: s.failures ? 'down' : 'stale',
        reason: s.last_error ?? 'no_poll_yet',
      };
    if (s.failures >= 3) return { status: 'down', reason: s.last_error };
    if (now() - s.last_success_at > interval * 2.5)
      return { status: 'stale', reason: s.last_error ?? 'no_recent_poll' };
    if (s.failures) return { status: 'degraded', reason: s.last_error };
    return source.access === 'trial'
      ? { status: 'trial', reason: 'test_data' }
      : { status: 'healthy', reason: null };
  }

  function summary(record, t) {
    return {
      id: record.id,
      sourceId: record.sourceId,
      domain: record.domain,
      warningType: record.warningType,
      title: record.title,
      authority: record.authority,
      status: warningStatus(record, t),
      severity: record.severity,
      trial: record.trial,
      chainId: record.chainId ?? record.id,
      contentHash: record.contentHash ?? null,
      isNew: t - Date.parse(record.firstSeenAtUtc) < NEW_WARNING_MS,
      lastChange: record.lastChange,
      publishedAtUtc: record.publishedAtUtc,
      effectiveFromUtc: record.effectiveFromUtc,
      effectiveUntilUtc: record.effectiveUntilUtc,
      geometry: record.geometry,
      geometryPrecision: record.geometryPrecision,
      // Computed once per stored geometry, not on every listing.
      bounds: (record.bounds ??= geometryBounds(record.geometry)),
      sourceUrl: record.sourceUrl,
    };
  }

  return {
    start({ firstDelayMs = 30_000 } = {}) {
      for (const [id, connector] of Object.entries(connectors)) {
        const due =
          (state[id]?.last_success_at ?? 0) + connector.intervalMs - now();
        const first = setTimeout(
          () => void pollSource(id),
          Math.max(firstDelayMs, Math.min(due, connector.intervalMs)),
        );
        const every = setInterval(
          () => void pollSource(id),
          connector.intervalMs,
        );
        first.unref?.();
        every.unref?.();
        timers.push(first, every);
      }
    },
    stop() {
      for (const id of timers) clearTimeout(id);
      save();
    },
    pollSource,
    sources() {
      return WARNING_SOURCES.map((source) => ({
        ...source,
        ...sourceStatus(source),
        last_success_at: state[source.id]?.last_success_at ?? null,
        // Why warnings are not being saved, or null.
        saving_paused: blockedReason,
        warnings: [...records.values()].filter((r) => r.sourceId === source.id)
          .length,
      }));
    },
    /** Changes whenever a source delivered (for caching list answers). */
    version: () => version,
    list({ domains = null, includeEnded = false, trial = true } = {}) {
      const t = now();
      return [...records.values()]
        .filter((r) => !domains || domains.includes(r.domain))
        .filter((r) => trial || !r.trial)
        .map((r) => summary(r, t))
        .filter(
          (r) =>
            includeEnded || r.status === 'active' || r.status === 'scheduled',
        );
    },
    detail(id) {
      const record = records.get(id);
      return record
        ? {
            ...summary(record, now()),
            originalText: record.originalText,
            geometryNotes: record.geometryNotes,
            provenance: record.provenance,
            history: record.history,
            firstSeenAtUtc: record.firstSeenAtUtc,
            lastVerifiedAtUtc: record.lastVerifiedAtUtc,
            endedAtUtc: record.endedAtUtc,
            endReason: record.endReason ?? null,
            cancelledAtUtc: record.cancelledAtUtc,
          }
        : null;
    },
    /** Distinct outline parts held (each shared by every warning using it). */
    storedOutlines: () => geometries.size,
    /** For tests and fixtures: apply drafts as a source would. */
    apply,
  };
}
