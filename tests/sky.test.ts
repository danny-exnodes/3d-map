import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CloudLayer, SkyDome, cloudCount, skyGradient } from '../src/scene/sky';

const lightness = (c: THREE.Color) => c.getHSL({ h: 0, s: 0, l: 0 }).l;

describe('sky', () => {
  it('skyGradient keeps the horizon and darkens the zenith, day and night', () => {
    for (const [hex, night] of [['#9fd3f2', 0], ['#101830', 1], ['#f0a070', 0.3]] as const) {
      const h = new THREE.Color(hex);
      const g = skyGradient(h, night);
      expect(g.horizon.getHex()).toBe(h.getHex());
      expect(lightness(g.top)).toBeLessThan(lightness(g.horizon));
    }
  });

  it('a golden horizon gets a bluish zenith, not a green one', () => {
    const { top } = skyGradient(new THREE.Color('#f8cfab'), 0);
    const h = top.getHSL({ h: 0, s: 0, l: 0 }).h;
    expect(h < 0.2 || h > 0.45).toBe(true);
    expect(h).toBeGreaterThan(0.45);
  });

  it('cloudCount maps cover to a monotonic integer count', () => {
    expect(cloudCount(0)).toBe(0);
    expect(cloudCount(1)).toBe(48);
    expect(cloudCount(0.5)).toBeGreaterThan(0);
    expect(cloudCount(0.5)).toBeLessThan(48);
    let prev = 0;
    for (let c = 0; c <= 1.0001; c += 0.1) {
      const n = cloudCount(c);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });

  it('CloudLayer shows no instances and is hidden at cover 0', () => {
    const layer = new CloudLayer(500);
    layer.setCover(0);
    expect(layer.mesh.count).toBe(0);
    expect(layer.mesh.visible).toBe(false);
    layer.setCover(1);
    expect(layer.mesh.count).toBe(48);
    expect(layer.mesh.visible).toBe(true);
    layer.dispose();
  });

  it('the dome ignores fog and the depth buffer', () => {
    const dome = new SkyDome();
    const m = dome.mesh.material as THREE.ShaderMaterial;
    expect(m.fog).toBe(false);
    expect(m.depthWrite).toBe(false);
    dome.dispose();
  });
});
