// Event emitter for the pipe transport: listeners run one after another, in
// registration order, and emit() resolves once the last one has settled.
export class SerialEmitter {
  #listeners = new Map();
  on(event, fn) {
    const list = this.#listeners.get(event) ?? [];
    list.push(fn);
    this.#listeners.set(event, list);
    return () => {
      const cur = this.#listeners.get(event) ?? [];
      this.#listeners.set(event, cur.filter(f => f !== fn));
    };
  }
  async emit(event, data) {
    for (const fn of this.#listeners.get(event) ?? []) await fn(data);
  }
}
