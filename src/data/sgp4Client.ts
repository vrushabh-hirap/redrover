/**
 * Main-thread client for the SGP4 worker. Falls back to in-thread propagation
 * when Workers are unavailable (older browsers, some test runners).
 */

import { CatalogObject, PropagatedState } from '../data/types';
import { Sgp4Propagator } from '../orbit/sgp4';

type ResultHandler = (states: PropagatedState[], valid: number, invalid: number) => void;

export class Sgp4Client {
  private worker: Worker | null = null;
  private fallback: Sgp4Propagator | null = null;
  private handlers = new Set<ResultHandler>();
  private pending = new Map<number, ResultHandler>();
  private valid = 0;
  private invalid = 0;

  get ready(): boolean {
    return this.worker !== null || this.fallback !== null;
  }

  get counts(): { valid: number; invalid: number } {
    return { valid: this.valid, invalid: this.invalid };
  }

  onResult(fn: ResultHandler): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  load(objects: CatalogObject[]): void {
    this.dispose();
    try {
      this.worker = new Worker(new URL('../workers/sgp4.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent) => this.handle(e.data);
      this.worker.postMessage({ type: 'INIT', objects });
    } catch {
      this.worker = null;
      this.fallback = new Sgp4Propagator(objects);
      this.valid = this.fallback.validCount;
      this.invalid = this.fallback.invalidCount;
    }
  }

  private handle(msg: any): void {
    if (msg.type === 'READY') {
      this.valid = msg.valid;
      this.invalid = msg.invalid;
    } else if (msg.type === 'RESULT') {
      const states: PropagatedState[] = [];
      for (let i = 0; i < msg.ids.length; i++) {
        states.push({
          noradId: msg.ids[i],
          position: { x: msg.positions[i * 3], y: msg.positions[i * 3 + 1], z: msg.positions[i * 3 + 2] },
          velocity: { x: 0, y: 0, z: 0 },
          altitudeKm: 0,
          speedKmS: 0,
        });
      }
      this.valid = msg.valid;
      this.invalid = msg.invalid;
      const cb = this.pending.get(msg.timestampMs);
      if (cb) {
        this.pending.delete(msg.timestampMs);
        cb(states, msg.valid, msg.invalid);
      }
      for (const h of this.handlers) h(states, msg.valid, msg.invalid);
    }
  }

  /** Propagate at `date`; `cb` is optional (all handlers are called too). */
  propagate(date: Date, cb?: ResultHandler): void {
    if (this.worker) {
      if (cb) this.pending.set(date.getTime(), cb);
      this.worker.postMessage({ type: 'PROPAGATE', timestampMs: date.getTime() });
      return;
    }
    if (!this.fallback) return;
    const states = this.fallback.propagateBatch(date);
    cb?.(states, this.fallback.validCount, this.fallback.invalidCount);
    for (const h of this.handlers) h(states, this.fallback.validCount, this.fallback.invalidCount);
  }

  /** Synchronous propagation (used by planning, which needs the states now). */
  propagateSync(date: Date, objects?: CatalogObject[]): PropagatedState[] {
    if (this.fallback) return this.fallback.propagateBatch(date);
    const p = new Sgp4Propagator(objects ?? []);
    return p.propagateBatch(date);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.fallback = null;
    this.pending.clear();
  }
}
