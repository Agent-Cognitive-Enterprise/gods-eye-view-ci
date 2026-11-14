// Shared outlines for the warning store (fork feature).
//
// NWS marine alerts take their outlines from whole forecast zones, and every
// update of an alert is a new record carrying the same zones again: one
// stored copy per record grew warnings.json past half a gigabyte (491 MB of
// it outlines, for 24 MB of distinct zones), until it could no longer be
// written as one JSON string. Here each polygon and each line is kept once,
// under a hash of its coordinates, and every geometry that uses it points at
// that one copy, in memory and on disk.
//
// Shared parts are frozen: geometry is read-only everywhere it is used
// (listing, simplifying for drawing, traffic correlation), and a change made
// through one warning must never show up in another.

import crypto from 'node:crypto';

const keyFor = (coordinates) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(coordinates))
    .digest('base64url')
    .slice(0, 24);

function deepFreeze(value) {
  if (Array.isArray(value) && !Object.isFrozen(value)) {
    for (const item of value) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** A store of shared polygon and line parts for warning geometry. */
export function createGeometryStore() {
  const parts = new Map(); // key -> frozen coordinates
  const keys = new WeakMap(); // frozen coordinates -> key

  /** The one shared copy of these coordinates. */
  function part(coordinates) {
    if (!Array.isArray(coordinates)) throw new TypeError('not coordinates');
    const known = keys.get(coordinates);
    if (known) return coordinates;
    const k = keyFor(coordinates);
    const existing = parts.get(k);
    if (existing) return existing;
    deepFreeze(coordinates);
    parts.set(k, coordinates);
    keys.set(coordinates, k);
    return coordinates;
  }

  /** The same geometry, built from shared parts. */
  function intern(g) {
    if (!g || typeof g !== 'object') return g ?? null;
    switch (g.type) {
      case 'Polygon':
      case 'LineString':
        return { type: g.type, coordinates: part(g.coordinates) };
      case 'MultiPolygon':
      case 'MultiLineString':
        return { type: g.type, coordinates: g.coordinates.map((c) => part(c)) };
      case 'GeometryCollection':
        return { type: g.type, geometries: g.geometries.map(intern) };
      default:
        return g; // points: small, kept inline
    }
  }

  const refOf = (coordinates) => keys.get(part(coordinates));

  /** The geometry as stored on disk: parts by key, `used` collects them. */
  function encode(g, used) {
    if (!g || typeof g !== 'object') return g ?? null;
    switch (g.type) {
      case 'Polygon':
      case 'LineString': {
        const ref = refOf(g.coordinates);
        used.add(ref);
        return { type: g.type, ref };
      }
      case 'MultiPolygon':
      case 'MultiLineString': {
        const refs = g.coordinates.map(refOf);
        for (const ref of refs) used.add(ref);
        return { type: g.type, refs };
      }
      case 'GeometryCollection':
        return {
          type: g.type,
          geometries: g.geometries.map((x) => encode(x, used)),
        };
      default:
        return g;
    }
  }

  /**
   * A stored geometry back from its parts table; null when a part is
   * missing (the record then lists without an outline, as when a zone
   * outline has not loaded yet).
   */
  function decode(stored, table) {
    if (!stored || typeof stored !== 'object') return stored ?? null;
    // Keys on disk are not trusted: each part is hashed again, so a wrong
    // key can never hand one outline another's coordinates. A part used
    // by many records is the same array each time and is hashed once.
    const load = (ref) => {
      if (typeof ref !== 'string' || !table || !Object.hasOwn(table, ref))
        return null;
      const coordinates = table[ref];
      return Array.isArray(coordinates) ? part(coordinates) : null;
    };
    switch (stored.type) {
      case 'Polygon':
      case 'LineString': {
        if (!('ref' in stored)) return intern(stored); // inline (older file)
        const coordinates = load(stored.ref);
        return coordinates ? { type: stored.type, coordinates } : null;
      }
      case 'MultiPolygon':
      case 'MultiLineString': {
        if (!Array.isArray(stored.refs)) return intern(stored);
        const coordinates = stored.refs.map(load);
        return coordinates.every(Boolean)
          ? { type: stored.type, coordinates }
          : null;
      }
      case 'GeometryCollection': {
        const geometries = (stored.geometries ?? []).map((x) =>
          decode(x, table),
        );
        return geometries.every(Boolean)
          ? { type: stored.type, geometries }
          : null;
      }
      default:
        return stored;
    }
  }

  /** Drop every part no stored geometry uses any more. */
  function keepOnly(used) {
    for (const [key, coordinates] of parts) {
      if (used.has(key)) continue;
      parts.delete(key);
      keys.delete(coordinates);
    }
  }

  return {
    intern,
    encode,
    decode,
    keepOnly,
    part: (key) => parts.get(key) ?? null,
    get size() {
      return parts.size;
    },
  };
}
