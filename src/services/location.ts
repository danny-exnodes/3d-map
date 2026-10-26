export type LocationSource = 'gps' | 'cache' | 'default';

export interface ResolvedLocation {
  lat: number;
  lon: number;
  source: LocationSource;
}

const CACHE_KEY = 'tinymap:lastLocation';

interface Deps {
  geolocation?: Pick<Geolocation, 'getCurrentPosition'> | null;
  permissions?: Pick<Permissions, 'query'> | null;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  timeoutMs?: number;
}

function readCache(storage: Deps['storage']): { lat: number; lon: number } | null {
  try {
    const raw = storage?.getItem(CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return Number.isFinite(v?.lat) && Number.isFinite(v?.lon) ? { lat: v.lat, lon: v.lon } : null;
  } catch {
    return null;
  }
}

function writeCache(storage: Deps['storage'], lat: number, lon: number) {
  try {
    storage?.setItem(CACHE_KEY, JSON.stringify({ lat, lon }));
  } catch {
    /* private mode / quota */
  }
}

/** Ask the browser for the current position; resolves null on any failure or timeout. */
export function getBrowserPosition(deps: Deps = defaultDeps()): Promise<{ lat: number; lon: number } | null> {
  const geo = deps.geolocation;
  if (!geo) return Promise.resolve(null);
  const timeout = deps.timeoutMs ?? 8000;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout + 500);
    try {
      geo.getCurrentPosition(
        (p) => {
          clearTimeout(timer);
          writeCache(deps.storage, p.coords.latitude, p.coords.longitude);
          resolve({ lat: p.coords.latitude, lon: p.coords.longitude });
        },
        () => {
          clearTimeout(timer);
          resolve(null);
        },
        { enableHighAccuracy: false, timeout, maximumAge: 10 * 60_000 },
      );
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/**
 * Startup location, in the order agreed in issue #2: last known position (instant), then the
 * browser position unless permission is denied, then the configured default. Never throws.
 */
export async function resolveStartLocation(fallback: { lat: number; lon: number }, deps: Deps = defaultDeps()): Promise<ResolvedLocation> {
  const cached = readCache(deps.storage);
  if (cached) return { ...cached, source: 'cache' };
  if (!(await permissionDenied(deps))) {
    const p = await getBrowserPosition(deps);
    if (p) return { ...p, source: 'gps' };
  }
  return { ...fallback, source: 'default' };
}

export async function permissionDenied(deps: Deps = defaultDeps()): Promise<boolean> {
  try {
    const st = await deps.permissions?.query({ name: 'geolocation' as PermissionName });
    return st?.state === 'denied';
  } catch {
    return false; // Permissions API unsupported: just try
  }
}

function defaultDeps(): Deps {
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  return {
    geolocation: typeof navigator !== 'undefined' && window.isSecureContext ? navigator.geolocation : null,
    permissions: typeof navigator !== 'undefined' ? navigator.permissions : null,
    storage,
  };
}
