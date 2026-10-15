/// <reference lib="webworker" />
/**
 * SGP4 batch propagation worker.
 *
 * Keeps catalog parsing and per-step propagation off the main thread so the
 * render loop never stalls. Positions come back as a single transferable
 * Float32Array (x, y, z per object, in the SGP4/TEME frame).
 */

import { Sgp4Propagator } from '../orbit/sgp4';
import { CatalogObject } from '../data/types';

export type Sgp4Request =
  | { type: 'INIT'; objects: CatalogObject[] }
  | { type: 'PROPAGATE'; timestampMs: number; range?: number[]; stepSec?: number };

export type Sgp4Response =
  | { type: 'READY'; valid: number; invalid: number }
  | { type: 'RESULT'; timestampMs: number; valid: number; invalid: number; positions: Float32Array; ids: Int32Array }
  | { type: 'ERROR'; message: string };

let propagator: Sgp4Propagator | null = null;
let objects: CatalogObject[] = [];

self.onmessage = (e: MessageEvent<Sgp4Request>) => {
  const msg = e.data;
  try {
    if (msg.type === 'INIT') {
      objects = msg.objects;
      propagator = new Sgp4Propagator(msg.objects);
      const res: Sgp4Response = {
        type: 'READY',
        valid: propagator.validCount,
        invalid: propagator.invalidCount,
      };
      (self as unknown as Worker).postMessage(res);
      return;
    }
    if (msg.type === 'PROPAGATE') {
      if (!propagator) return;
      const date = new Date(msg.timestampMs);
      const states = propagator.propagateBatch(date);
      const positions = new Float32Array(states.length * 3);
      const ids = new Int32Array(states.length);
      states.forEach((s, i) => {
        positions[i * 3] = s.position.x;
        positions[i * 3 + 1] = s.position.y;
        positions[i * 3 + 2] = s.position.z;
        ids[i] = s.noradId;
      });
      const res: Sgp4Response = {
        type: 'RESULT',
        timestampMs: msg.timestampMs,
        valid: propagator.validCount,
        invalid: propagator.invalidCount,
        positions,
        ids,
      };
      (self as unknown as Worker).postMessage(res, [positions.buffer, ids.buffer]);
      void objects;
    }
  } catch (err) {
    const res: Sgp4Response = { type: 'ERROR', message: String(err) };
    (self as unknown as Worker).postMessage(res);
  }
};
