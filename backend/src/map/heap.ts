/** Montículo binario de mínimos sobre pares [prioridad, valor]. */
export class MinHeap<T> {
  private items: [number, T][] = [];

  get size() {
    return this.items.length;
  }

  push(priority: number, value: T) {
    const a = this.items;
    a.push([priority, value]);
    for (let i = a.length - 1, p = (i - 1) >> 1; i > 0 && a[p][0] > a[i][0]; i = p, p = (i - 1) >> 1) [a[p], a[i]] = [a[i], a[p]];
  }

  pop(): [number, T] | undefined {
    const a = this.items;
    if (!a.length) return;
    const top = a[0], last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}
