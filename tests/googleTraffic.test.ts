import { describe, expect, it, vi } from 'vitest';
import { decodePolyline, matchRoad, routeTraffic, SPEED_RATIO } from '../src/data/googleTraffic';

describe('Google traffic (#11)', () => {
  it('decodes Google encoded polylines', () => {
    // Example from Google's polyline documentation.
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(pts[0][1]).toBeCloseTo(38.5, 5);
    expect(pts[0][0]).toBeCloseTo(-120.2, 5);
    expect(pts[2][1]).toBeCloseTo(43.252, 5);
  });

  it('splits a route by speed readings and matches them onto roads', async () => {
    const encoded = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ routes: [{ polyline: { encodedPolyline: encoded }, travelAdvisory: { speedReadingIntervals: [{ startPolylinePointIndex: 0, endPolylinePointIndex: 1, speed: 'TRAFFIC_JAM' }, { startPolylinePointIndex: 1, endPolylinePointIndex: 2 }] } }] })));
    vi.stubGlobal('fetch', fetchMock);
    const pieces = await routeTraffic([-120.2, 38.5], [-126.453, 43.252], 'KEY');
    expect(pieces.map((p) => p.speed)).toEqual(['TRAFFIC_JAM', 'NORMAL']);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('KEY');
    expect(JSON.parse(init.body as string).extraComputations).toEqual(['TRAFFIC_ON_POLYLINE']);
    vi.unstubAllGlobals();

    // Local metres: a road along a jammed piece, another far away.
    const jam = { line: [[0, 0], [200, 0]] as [number, number][], speed: 'TRAFFIC_JAM' as const };
    expect(matchRoad([[10, 3], [150, 4]], [jam])).toBe(SPEED_RATIO.TRAFFIC_JAM);
    expect(matchRoad([[10, 80], [150, 80]], [jam])).toBeNull();
  });
});
