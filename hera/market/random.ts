/**
 * A small seedable PRNG so the market engine is deterministic and testable.
 *
 * This is a mulberry32 generator: fast, dependency-free and reproducible from a
 * single integer seed. It does not need to match Python's Mersenne Twister
 * exactly -- only to make a seeded run replay identically.
 */
export class Random {
  private state: number;

  constructor(seed = Date.now() >>> 0) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  random(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Inclusive integer in [min, max]. */
  randint(min: number, max: number): number {
    return min + Math.floor(this.random() * (max - min + 1));
  }

  /** Uniform float in [min, max). */
  uniform(min: number, max: number): number {
    return min + this.random() * (max - min);
  }

  /** Standard normal via the Box-Muller transform. */
  gauss(mu = 0.0, sigma = 1.0): number {
    let u = 0;
    let v = 0;
    // Avoid log(0), which would return -Infinity.
    while (u === 0) u = this.random();
    while (v === 0) v = this.random();
    return mu + sigma * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  choice<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('choice from an empty collection');
    return items[this.randint(0, items.length - 1)];
  }

  /** Weighted choice, mirroring ``random.choices(..., k=1)``. */
  choices<T>(items: readonly T[], weights?: readonly number[]): T {
    if (items.length === 0) throw new Error('choices from an empty collection');
    if (!weights) return this.choice(items);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let target = this.random() * total;
    for (let index = 0; index < items.length; index += 1) {
      target -= weights[index];
      if (target < 0) return items[index];
    }
    return items[items.length - 1];
  }
}
