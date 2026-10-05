/** Fixed-capacity history: constant-time insertion, ordered snapshots on demand. */
export class RecentBuffer<T> {
  private readonly items: T[] = [];
  private next = 0;

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Invalid capacity");
  }

  push(item: T): void {
    this.items[this.next] = item;
    this.next = (this.next + 1) % this.capacity;
  }

  snapshot(): T[] {
    if (this.items.length < this.capacity) return this.items.slice();
    return this.items.slice(this.next).concat(this.items.slice(0, this.next));
  }
}
