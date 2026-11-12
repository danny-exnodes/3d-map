import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { loadTransit, routesInBbox, stopsInBbox, transitCityFor, type TransitFile } from '../src/data/transit';
import { LocalProjection } from '../src/geo/projection';
import { buildTransit } from '../src/scene/transit';

const BBOX = { west: 105.79, south: 20.99, east: 105.81, north: 21.01 };

const file = (): TransitFile => ({
  meta: { city: 'hn', source: 'Test feed', sourceDate: '2024-01', official: true, license: 'CC-BY', generated: '2024-01-01' },
  routes: [
    // Inside the bbox.
    { id: 'r1', name: '09A', color: '#e3372a', shape: [[105.795, 21.0], [105.805, 21.0]] },
    // Fully outside the bbox (and far from the built model).
    { id: 'r2', name: 'far', color: '#2f6fb3', shape: [[106.5, 21.5], [106.6, 21.6]] },
  ],
  stops: [
    { id: 's1', name: 'In', lon: 105.8, lat: 21.0 },
    { id: 's2', name: 'Out', lon: 106.5, lat: 21.5 },
  ],
});

describe('transitCityFor (#56)', () => {
  it('picks Hà Nội north of 16°, TP.HCM south of it', () => {
    expect(transitCityFor(21.03)).toBe('hn');
    expect(transitCityFor(10.78)).toBe('hcm');
    expect(transitCityFor(16)).toBe('hcm');
  });
});

describe('routesInBbox / stopsInBbox', () => {
  it('keeps only routes/stops touching the bbox', () => {
    const f = file();
    expect(routesInBbox(f, BBOX).map((r) => r.id)).toEqual(['r1']);
    expect(stopsInBbox(f, BBOX).map((s) => s.id)).toEqual(['s1']);
  });
});

describe('loadTransit', () => {
  it('fetches transit/<city>.json under base and caches it in memory', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(file())));
    vi.stubGlobal('fetch', fetchMock);
    const base = 'http://x/app/';
    const a = await loadTransit('hn', base);
    const b = await loadTransit('hn', base);
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown as [URL])[0])).toBe('http://x/app/transit/hn.json');
    vi.unstubAllGlobals();
  });
});

describe('buildTransit (#56)', () => {
  it('draws routes as one merged mesh and stops as one InstancedMesh, clipped to the model', () => {
    const proj = new LocalProjection(BBOX);
    const built = buildTransit(file(), BBOX, proj);
    expect(built.routes).toBe(1);
    expect(built.stops).toBe(1);
    const instanced = built.group.children.filter((o) => o instanceof THREE.InstancedMesh);
    const meshes = built.group.children.filter((o) => o instanceof THREE.Mesh && !(o instanceof THREE.InstancedMesh));
    expect(meshes.length).toBe(1);
    expect(instanced.length).toBe(1);
  });

  it('returns an empty group when nothing is in range', () => {
    const proj = new LocalProjection(BBOX);
    const empty: TransitFile = { ...file(), routes: [], stops: [] };
    const built = buildTransit(empty, BBOX, proj);
    expect(built.routes).toBe(0);
    expect(built.stops).toBe(0);
    expect(built.group.children.length).toBe(0);
  });
});
