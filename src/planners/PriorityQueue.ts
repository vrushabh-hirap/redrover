export class PriorityQueue<T> {
  private heap: { item: T; priority: number }[] = [];

  get size(): number {
    return this.heap.length;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  push(item: T, priority: number): void {
    this.heap.push({ item, priority });
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): T | undefined {
    if (this.isEmpty()) return undefined;
    const top = this.heap[0].item;
    const bottom = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = bottom;
      this.bubbleDown(0);
    }
    return top;
  }

  private bubbleUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (this.heap[current].priority < this.heap[parent].priority) {
        const temp = this.heap[current];
        this.heap[current] = this.heap[parent];
        this.heap[parent] = temp;
        current = parent;
      } else {
        break;
      }
    }
  }

  private bubbleDown(index: number): void {
    let current = index;
    const length = this.heap.length;
    while (true) {
      const left = 2 * current + 1;
      const right = 2 * current + 2;
      let smallest = current;

      if (left < length && this.heap[left].priority < this.heap[smallest].priority) {
        smallest = left;
      }
      if (right < length && this.heap[right].priority < this.heap[smallest].priority) {
        smallest = right;
      }

      if (smallest !== current) {
        const temp = this.heap[current];
        this.heap[current] = this.heap[smallest];
        this.heap[smallest] = temp;
        current = smallest;
      } else {
        break;
      }
    }
  }
}

/**
 * Key serialization helper for GridCoord
 */
export function coordKey(c: { x: number; y: number }): string {
  return `${c.x},${c.y}`;
}

export function parseKey(key: string): { x: number; y: number } {
  const [x, y] = key.split(',').map(Number);
  return { x, y };
}

/**
 * Admissible octile distance heuristic for 8-connected grid.
 * Since min step cost is 1.0 (orthogonal) and sqrt(2) (diagonal),
 * octile distance h(n) <= true distance <= true cost (since cost >= dist).
 */
export function octileDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
}
