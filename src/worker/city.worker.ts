/// <reference lib="webworker" />
import { generateDemoCity } from '../data/demo';
import { loadCity } from '../data/loader';
import { parseOverpass, type OverpassResponse } from '../data/osm';
import { buildCity } from '../scene/buildCity';
import { serializeObject } from '../scene/serialize';
import type { BuildResult, WorkerRequest, WorkerResponse } from './protocol';

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

const controllers = new Map<number, AbortController>();

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  if (req.op === 'abort') {
    controllers.get(req.target)?.abort();
    return;
  }
  try {
    if (req.op === 'loadCity') {
      const ctrl = new AbortController();
      controllers.set(req.id, ctrl);
      try {
        const data = await loadCity(req.bbox, { ...req.opts, signal: ctrl.signal }, (p) => post({ id: req.id, type: 'progress', ...p }));
        post({ id: req.id, type: 'result', result: data });
      } finally {
        controllers.delete(req.id);
      }
      return;
    }
    if (req.op === 'build') {
      const built = buildCity(req.data, (f, detail) => post({ id: req.id, type: 'progress', f, detail }), req.style);
      const { objects, transfer } = serializeObject(built.group);
      const result: BuildResult = { objects, paths: built.paths, railPaths: built.railPaths, buildings: built.buildings, trees: built.trees, buildingIds: built.buildingIds };
      post({ id: req.id, type: 'result', result }, transfer);
    } else if (req.op === 'parseOverpass') {
      post({ id: req.id, type: 'result', result: parseOverpass(req.bbox, JSON.parse(req.text) as OverpassResponse) });
    } else if (req.op === 'demo') {
      post({ id: req.id, type: 'result', result: generateDemoCity(req.bbox) });
    }
  } catch (e) {
    post({ id: req.id, type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
