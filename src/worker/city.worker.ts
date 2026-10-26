/// <reference lib="webworker" />
import { generateDemoCity } from '../data/demo';
import { parseOverpass, type OverpassResponse } from '../data/osm';
import { buildCity } from '../scene/buildCity';
import { serializeObject } from '../scene/serialize';
import type { BuildResult, WorkerRequest, WorkerResponse } from './protocol';

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.op === 'build') {
      const built = buildCity(req.data, (f, detail) => post({ id: req.id, type: 'progress', f, detail }));
      const { objects, transfer } = serializeObject(built.group);
      const result: BuildResult = { objects, paths: built.paths, railPaths: built.railPaths, buildings: built.buildings, trees: built.trees };
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
