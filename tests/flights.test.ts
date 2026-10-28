import { describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/adsbfi-hanoi.json';
import { DEFAULT_FLIGHTS_RELAY, fetchFlights, flightsRelay, flightsUrl, parseFlights } from '../src/data/flights';

const NOW = 1_000_000;
const store = (v: string | null) => ({ getItem: () => v }) as unknown as Storage;

describe('parseFlights', () => {
  const flights = parseFlights(fixture, NOW);

  it('keeps only rows with a numeric position', () => {
    expect(flights).toHaveLength(12);
    expect(flights.find((f) => f.callsign === 'NOPOS')).toBeUndefined();
  });

  it('converts ground to 0 m, feet to metres and knots to m/s', () => {
    expect(flights.find((f) => f.callsign === 'VJC939')!.altM).toBe(0);
    const lao = flights.find((f) => f.callsign === 'LAO924')!;
    expect(lao.altM).toBeCloseTo(11582.4, 0);
    expect(lao.gsMs).toBeCloseTo(244.5, 1);
  });

  it('trims the callsign and fills type, heading and the time of the last position', () => {
    const f = flights[0];
    expect(f.callsign).toBe('CKS9602');
    expect(f.type).toBe('B744');
    expect(f.trackDeg).toBeCloseTo(104.2);
    expect(f.seenAt).toBeCloseTo(NOW - 324, 5);
  });

  it('uses alt_geom when alt_baro is missing and skips rows with no altitude', () => {
    const base = { hex: 'x', lat: 21, lon: 105 };
    const f = parseFlights({ aircraft: [{ ...base, alt_geom: 1000 }, { ...base, flight: 'NOALT' }] }, NOW);
    expect(f).toHaveLength(1);
    expect(f[0].altM).toBeCloseTo(304.8);
  });

  it('skips out-of-range or non-finite positions and zeroes bad gs/track', () => {
    const ok = { alt_baro: 0, lat: 21, lon: 105 };
    const f = parseFlights({ aircraft: [{ ...ok, lat: 91 }, { ...ok, lon: -181 }, { ...ok, lat: null }, { ...ok, gs: 'x', track: NaN }] }, NOW);
    expect(f).toHaveLength(1);
    expect([f[0].gsMs, f[0].trackDeg]).toEqual([0, 0]);
  });

  it('accepts the adsb.lol "ac" key and tolerates junk', () => {
    expect(parseFlights({ ac: (fixture as any).aircraft.slice(0, 2) }, NOW)).toHaveLength(2);
    expect(parseFlights({}, NOW)).toEqual([]);
    expect(parseFlights(null, NOW)).toEqual([]);
  });
});

describe('flightsRelay', () => {
  it('prefers ?flights=, then storage, then the default, then the dev proxy', () => {
    expect(flightsRelay('?flights=https://a.test', store('https://b.test'), true)).toBe('https://a.test');
    expect(flightsRelay('', store('https://b.test'), true)).toBe('https://b.test');
    expect(DEFAULT_FLIGHTS_RELAY).toBe('');
    expect(flightsRelay('', store(null), true)).toBe('/flights-api');
    expect(flightsRelay('', null, false)).toBeNull();
  });

  it('ignores relays that are not https or a same-origin path', () => {
    for (const bad of ['http://a.test', 'javascript:alert(1)', '//evil.test', 'data:text/plain,x']) {
      expect(flightsRelay('?flights=' + encodeURIComponent(bad), store(bad), false)).toBeNull();
    }
    expect(flightsRelay('?flights=/relay', null, false)).toBe('/relay');
  });
});

describe('flightsUrl', () => {
  it('builds the readsb path with 4 decimals', () => {
    expect(flightsUrl('/flights-api', 21.03, 105.85, 40)).toBe('/flights-api/v2/lat/21.0300/lon/105.8500/dist/40');
  });
});

describe('fetchFlights', () => {
  it('rejects on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })));
    await expect(fetchFlights('/flights-api', 21, 105, 40)).rejects.toThrow();
    vi.unstubAllGlobals();
  });

  it('rejects a 200 with a non-JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>')));
    await expect(fetchFlights('/flights-api', 21, 105, 40)).rejects.toThrow();
    vi.unstubAllGlobals();
  });

  it('passes the abort signal to fetch', async () => {
    const f = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', f);
    const ac = new AbortController();
    await fetchFlights('/flights-api', 21, 105, 40, ac.signal);
    expect((f.mock.calls[0] as unknown[])[1]).toEqual({ signal: ac.signal });
    vi.unstubAllGlobals();
  });

  it('parses a good response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(fixture))));
    expect(await fetchFlights('/flights-api', 21, 105, 40)).toHaveLength(12);
    vi.unstubAllGlobals();
  });
});
