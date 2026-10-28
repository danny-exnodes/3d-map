import { describe, expect, it } from 'vitest';
import { kindFromLive, parseWeatherKind, weatherPreset, WEATHER_ICON, WEATHER_KINDS, WEATHER_LABEL } from '../src/scene/weather';
import { describeWeather, type Weather } from '../src/services/weather';

const live = (code: number, cloudCover = 0.2): Weather => ({ temperature: 30, code, cloudCover, precipitation: 0, ...describeWeather(code) });

describe('weather presets', () => {
  it('clear is bright, dry and far-sighted', () => {
    const p = weatherPreset('clear');
    expect(p.cloud).toBeLessThanOrEqual(0.1);
    expect(p.rain).toBe(0);
    expect(p.lightning).toBe(false);
    expect(p.fogScale).toBe(1);
  });
  it('storm is heavy rain, dark clouds and lightning, darker than rain', () => {
    const p = weatherPreset('storm');
    expect(p.rain).toBe(2);
    expect(p.lightning).toBe(true);
    expect(p.cloud).toBeGreaterThanOrEqual(0.9);
    expect(p.dim).toBeGreaterThan(weatherPreset('rain').dim);
  });
  it('fog pulls the fog distance in without rain', () => {
    const p = weatherPreset('fog');
    expect(p.fogScale).toBeLessThan(0.5);
    expect(p.rain).toBe(0);
  });
  it('has a label and icon for every kind', () => {
    expect(WEATHER_KINDS).toEqual(['auto', 'clear', 'cloudy', 'rain', 'storm', 'fog']);
    for (const k of WEATHER_KINDS) {
      expect(WEATHER_LABEL[k]).toBeTruthy();
      expect(WEATHER_ICON[k]).toBeTruthy();
    }
  });
});

describe('kindFromLive', () => {
  it('maps WMO codes to a kind', () => {
    expect(kindFromLive(live(0))).toBe('clear');
    expect(kindFromLive(live(3))).toBe('cloudy');
    expect(kindFromLive(live(45))).toBe('fog');
    expect(kindFromLive(live(61))).toBe('rain');
    expect(kindFromLive(live(95))).toBe('storm');
  });
});

describe('parseWeatherKind', () => {
  it('accepts known kinds only', () => {
    expect(parseWeatherKind('storm')).toBe('storm');
    expect(parseWeatherKind('snow')).toBeNull();
    expect(parseWeatherKind(null)).toBeNull();
  });
});
