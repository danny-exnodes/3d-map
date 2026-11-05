import { describe, expect, it } from 'vitest';
import { clampFlood, FLOOD_MAX, FLOOD_PRESETS, FloodWater, floodLabel, floodPace, parseFloodDepth } from '../src/scene/floodScenario';

describe('flood depth (?ngap=)', () => {
  it('parses metres, centimetres and a Vietnamese decimal comma', () => {
    expect(parseFloodDepth('0.5')).toBe(0.5);
    expect(parseFloodDepth('0,3')).toBeCloseTo(0.3);
    expect(parseFloodDepth('30cm')).toBeCloseTo(0.3);
    expect(parseFloodDepth(' 1 m ')).toBe(1);
  });

  it('clamps to the slider range and snaps to 5 cm', () => {
    expect(parseFloodDepth('9')).toBe(FLOOD_MAX);
    expect(clampFlood(0.33)).toBeCloseTo(0.35);
    expect(clampFlood(-1)).toBe(0);
    expect(clampFlood(NaN)).toBe(0);
  });

  it('ignores missing or invalid values', () => {
    for (const s of [null, undefined, '', 'abc', '-1', '1e3']) expect(parseFloodDepth(s)).toBeNull();
  });

  it('labels depths for the UI', () => {
    expect(floodLabel(0)).toBe('Khô');
    expect(floodLabel(0.3)).toBe('0,3 m');
    expect(floodLabel(1)).toBe('1 m');
  });

  it('has presets inside the range, starting dry', () => {
    expect(FLOOD_PRESETS[0].depth).toBe(0);
    for (const p of FLOOD_PRESETS) expect(clampFlood(p.depth)).toBeCloseTo(p.depth);
  });
});

describe('floodPace', () => {
  it('leaves traffic alone in a puddle and slows it to a crawl by half a metre', () => {
    expect(floodPace(0)).toBe(1);
    expect(floodPace(0.1)).toBe(1);
    expect(floodPace(0.3)).toBeLessThan(0.7);
    expect(floodPace(0.5)).toBeCloseTo(0.15);
    expect(floodPace(1.5)).toBeCloseTo(0.15);
  });

  it('never speeds traffic up as the water rises', () => {
    let last = 1;
    for (let d = 0; d <= FLOOD_MAX; d += 0.05) {
      const p = floodPace(d);
      expect(p).toBeLessThanOrEqual(last + 1e-9);
      last = p;
    }
  });
});

describe('FloodWater', () => {
  it('is hidden when dry and rises smoothly to the target', () => {
    const f = new FloodWater(800, 600);
    expect(f.mesh.visible).toBe(false);
    f.setDepth(0.5);
    expect(f.level).toBe(0);
    let frames = 0;
    while (f.update(1 / 60) && frames < 1000) frames++;
    expect(f.level).toBeCloseTo(0.5);
    expect(frames).toBeGreaterThan(20); // not a jump
    expect(frames).toBeLessThan(400); // a few seconds at most
    expect(f.mesh.visible).toBe(true);
    expect(f.mesh.scale.y).toBeCloseTo(0.5);
    f.setDepth(0, true);
    expect(f.mesh.visible).toBe(false);
    f.dispose();
  });

  it('jumps straight to the level with reduced motion', () => {
    const f = new FloodWater(100, 100);
    f.setDepth(1);
    f.update(1 / 60, true);
    expect(f.level).toBe(1);
  });
});
