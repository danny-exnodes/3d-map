import type { CityLoadOptions } from '../data/loader';
import type { BBox, CityData } from '../data/types';
import type { Style } from '../scene/style';
import type { BuildResult, WorkerRequest, WorkerResponse } from './protocol';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (f: number, d: string, step?: string) => void };
type Op = WorkerRequest extends infer R ? (R extends { op: infer O } ? O : never) : never;

/** Promise wrapper around the city worker. `available` is false where module workers are unsupported. */
class CityWorkerClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();

  get available(): boolean {
    return this.ensure() !== null;
  }

  private ensure(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') return null;
    try {
      this.worker = new Worker(new URL('./city.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        const msg = ev.data;
        const p = this.pending.get(msg.id);
        if (!p) return;
        if (msg.type === 'progress') p.onProgress?.(msg.f, msg.detail, msg.step);
        else {
          this.pending.delete(msg.id);
          if (msg.type === 'result') p.resolve(msg.result);
          else p.reject(new Error(msg.message));
        }
      };
      this.worker.onerror = (e) => {
        for (const p of this.pending.values()) p.reject(new Error(e.message || 'worker error'));
        this.pending.clear();
      };
    } catch {
      this.worker = null;
    }
    return this.worker;
  }

  private call<T>(op: Op, payload: Record<string, unknown>, onProgress?: Pending['onProgress'], signal?: AbortSignal): Promise<T> {
    const w = this.ensure();
    if (!w) return Promise.reject(new Error('Web Worker unavailable'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      w.postMessage({ id, op, ...payload });
      signal?.addEventListener('abort', () => {
        w.postMessage({ id: ++this.seq, op: 'abort', target: id });
        this.pending.delete(id);
        reject(new DOMException('Đã huỷ', 'AbortError'));
      });
    });
  }

  loadCity(bbox: BBox, opts: Omit<CityLoadOptions, 'signal'>, onProgress: NonNullable<Pending['onProgress']>, signal?: AbortSignal) {
    return this.call<CityData>('loadCity', { bbox, opts }, onProgress, signal);
  }

  build(data: CityData, style: Style, onProgress?: Pending['onProgress']) {
    return this.call<BuildResult>('build', { data, style }, onProgress);
  }

  parseOverpass(bbox: BBox, text: string) {
    return this.call<CityData>('parseOverpass', { bbox, text });
  }

  demo(bbox: BBox) {
    return this.call<CityData>('demo', { bbox });
  }
}

export const cityWorker = new CityWorkerClient();
