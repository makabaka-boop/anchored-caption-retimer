import { describe, expect, it } from 'vitest';
import {
  buildDocument,
  Cue,
  DAY_MS,
  parseCues,
  solveStarts,
} from './cues';

// ---------- 测试辅助 ----------

function mkCues(starts: number[], durations: number[]): Cue[] {
  return starts.map((start, i) => ({ start, duration: durations[i], text: `c${i}` }));
}

function prefixA(cues: readonly Cue[]): number[] {
  const A = [0];
  for (let i = 0; i + 1 < cues.length; i++) A.push(A[i] + cues[i].duration);
  return A;
}

/**
 * 短序列参考解：在 z 空间直接枚举全部可行保序整数序列，
 * 保留最小代价；平局取字典序最小向量。
 */
function bruteForce(
  cues: readonly Cue[],
  baseline: readonly number[],
  pins: ReadonlyMap<number, number>,
  dayMs: number,
): { feasible: boolean; starts: number[]; cost: number } {
  const n = cues.length;
  const A = prefixA(cues);
  const pinZ = new Map<number, number>();
  for (const [idx, v] of pins) pinZ.set(idx, v - A[idx]);

  const bestRef: { v: number[] | null } = { v: null };
  let bestCost = Infinity;

  const rec = (i: number, prev: number, z: number[], cost: number): void => {
    if (cost > bestCost) return;
    if (i === n) {
      const best = bestRef.v;
      if (best === null || cost < bestCost || (cost === bestCost && lexLess(z, best))) {
        bestRef.v = z.slice();
        bestCost = cost;
      }
      return;
    }
    const w = baseline[i] - A[i];
    // 枚举下界：0（保证 x_i=z_i+A_i≥0）、保序前驱、自身固定值、更早固定值
    let lo = Math.max(0, prev);
    // 枚举上界：全天边界、自身固定值、更晚固定值
    let hi = dayMs - A[i];
    const own = pinZ.get(i);
    for (const [j, pv] of pinZ) {
      if (j < i) lo = Math.max(lo, pv);
      if (j > i) hi = Math.min(hi, pv);
    }
    if (own !== undefined) {
      lo = Math.max(lo, own);
      hi = Math.min(hi, own);
    }
    for (let zi = lo; zi <= hi; zi++) {
      z.push(zi);
      rec(i + 1, zi, z, cost + Math.abs(zi - w));
      z.pop();
    }
  };

  rec(0, 0, [], 0);
  const solution = bestRef.v;
  if (solution === null) return { feasible: false, starts: [], cost: 0 };
  return {
    feasible: true,
    starts: solution.map((zi, i) => zi + A[i]),
    cost: bestCost,
  };
}

function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertValid(
  cues: readonly Cue[],
  starts: readonly number[],
  pins: ReadonlyMap<number, number>,
  dayMs: number,
): void {
  for (let i = 0; i < starts.length; i++) {
    expect(Number.isInteger(starts[i])).toBe(true);
    expect(starts[i]).toBeGreaterThanOrEqual(0);
    expect(starts[i]).toBeLessThanOrEqual(dayMs);
    if (i > 0) expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1] + cues[i - 1].duration);
    const pin = pins.get(i);
    if (pin !== undefined) expect(starts[i]).toBe(pin);
  }
}

// ---------- 穷举核对 ----------

describe('solveStarts 短序列穷举', () => {
  it('随机短序列：目标值与完整向量逐案一致', () => {
    const rnd = mulberry32(20260918);
    let tieCases = 0;
    for (let caseNo = 0; caseNo < 400; caseNo++) {
      const n = 1 + Math.floor(rnd() * 4); // 1..4
      const dayMs = 10 + Math.floor(rnd() * 6); // 10..15
      const durations = Array.from({ length: n }, () => 1 + Math.floor(rnd() * 2));
      const baseline: number[] = [];
      let b = Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) {
        baseline.push(b);
        b += 1 + Math.floor(rnd() * 3);
      }
      const pins = new Map<number, number>();
      for (let i = 0; i < n; i++) {
        if (rnd() < 0.35) pins.set(i, Math.floor(rnd() * (dayMs + 1)));
      }
      const cues = mkCues(baseline, durations);
      const got = solveStarts(cues, baseline, pins, dayMs);
      const ref = bruteForce(cues, baseline, pins, dayMs);
      expect(got.feasible, `case ${caseNo} feasibility`).toBe(ref.feasible);
      if (ref.feasible) {
        expect(got.cost, `case ${caseNo} cost`).toBe(ref.cost);
        expect(got.starts, `case ${caseNo} vector`).toEqual(ref.starts);
        assertValid(cues, got.starts, pins, dayMs);
        // 平局观测：参考解起点与采纳稿不同且存在其它等值解时记一次
        if (got.starts.some((s, i) => s !== baseline[i])) tieCases++;
      }
    }
    expect(tieCases).toBeGreaterThan(20); // 确实覆盖了需要位移的场景
  });

  it('无固定点可行稿应原样返回（代价 0）', () => {
    const baseline = [0, 500, 1200];
    const cues = mkCues(baseline, [400, 600, 10]);
    const got = solveStarts(cues, baseline, new Map(), 86400000);
    expect(got.feasible).toBe(true);
    expect(got.cost).toBe(0);
    expect(got.starts).toEqual(baseline);
  });
});

describe('偶数块平局（取字典序最小整数向量）', () => {
  it('2 项合并块：w=[5,3]，平台 [3,5]，取 3', () => {
    // b=[5,6], d0=3 -> w=[5,3]；z0=z1=t ∈ [3,5] 代价同为 2
    const cues = mkCues([5, 6], [3, 1]);
    const got = solveStarts(cues, [5, 6], new Map(), 100);
    expect(got.feasible).toBe(true);
    expect(got.cost).toBe(2);
    expect(got.starts).toEqual([3, 6]);
  });

  it('4 项合并块：w=[5,5,3,3]，平台 [3,5]，整体取 3', () => {
    const cues = mkCues([5, 8, 9, 12], [3, 3, 3, 1]);
    const got = solveStarts(cues, [5, 8, 9, 12], new Map(), 100);
    expect(got.feasible).toBe(true);
    expect(got.cost).toBe(4);
    expect(got.starts).toEqual([3, 6, 9, 12]);
    // 反向验证 t=5 同代价但字典序更大
    const ref = bruteForce(cues, [5, 8, 9, 12], new Map(), 100);
    expect(ref.starts).toEqual([3, 6, 9, 12]);
    expect(ref.cost).toBe(4);
  });

  it('固定点切割后仍含偶数自由块，自由块取其平台左端', () => {
    // day=100 等效大日；pin x2=18 => z2=18-6=12 抬升后两块自由 cue
    // b=[5,8,9,12], d=[3,3,3,1], w=[5,5,3,3]
    // z2=12 强制 z0,z1≤12 不构成下界；块 [w0,w1]=[5,5] 中位 5（唯一），
    // z3 ≥ 12 而 w3=3 => 唯一取 12。主验证：精确命中且可行
    const cues = mkCues([5, 8, 9, 12], [3, 3, 3, 1]);
    const pins = new Map([[2, 18]]);
    const got = solveStarts(cues, [5, 8, 9, 12], pins, 100);
    const ref = bruteForce(cues, [5, 8, 9, 12], pins, 100);
    expect(got.feasible).toBe(true);
    expect(got.cost).toBe(ref.cost);
    expect(got.starts).toEqual(ref.starts);
    expect(got.starts[2]).toBe(18);
  });
});

describe('固定点临界冲突与边界', () => {
  it('固定点把后一条挤出全天：INFEASIBLE', () => {
    const cues = mkCues([0, 0], [5, 1]);
    const pins = new Map([[0, 10]]);
    // x1 ≥ 15 > day 12
    const got = solveStarts(cues, [0, 1], pins, 12);
    expect(got.feasible).toBe(false);
    expect(got.starts).toEqual([]);
  });

  it('两个固定点违反先后顺序：INFEASIBLE', () => {
    const cues = mkCues([0, 0, 0], [2, 2, 1]);
    const pins = new Map<number, number>([
      [0, 9],
      [2, 8],
    ]);
    const got = solveStarts(cues, [0, 1, 2], pins, 20);
    expect(got.feasible).toBe(false);
  });

  it('固定点恰好满足最小间隔：可行且精确命中', () => {
    const cues = mkCues([0, 0, 0], [4, 4, 1]);
    const pins = new Map<number, number>([
      [0, 2],
      [2, 10],
    ]);
    const got = solveStarts(cues, [0, 0, 0], pins, 20);
    expect(got.feasible).toBe(true);
    expect(got.starts).toEqual([2, 6, 10]);
    expect(got.cost).toBe(2 + 6 + 10);
  });

  it('末条固定点恰在全天终点：可行', () => {
    const cues = mkCues([0, 0], [3, 1]);
    const pins = new Map([[1, 12]]); // z1=9
    const got = solveStarts(cues, [1, 2], pins, 12);
    expect(got.feasible).toBe(true);
    expect(got.starts[1]).toBe(12);
    expect(got.starts[0]).toBeLessThanOrEqual(9);
    const ref = bruteForce(cues, [1, 2], pins, 12);
    expect(got.starts).toEqual(ref.starts);
    expect(got.cost).toBe(ref.cost);
  });

  it('首条固定在全天终点且后续有时长：INFEASIBLE', () => {
    const cues = mkCues([0, 0], [60000, 1]);
    const pins = new Map([[0, DAY_MS]]);
    const got = solveStarts(cues, [0, 1], pins);
    expect(got.feasible).toBe(false);
  });

  it('总时长超过全天：无固定点也 INFEASIBLE', () => {
    const cues = mkCues([0, 0], [8, 8]);
    const got = solveStarts(cues, [0, 1], new Map(), 7);
    expect(got.feasible).toBe(false);
  });

  it('固定点重复编辑覆盖：同一索引只有一个生效值', () => {
    const cues = mkCues([0, 5], [2, 2]);
    const once = solveStarts(cues, [0, 5], new Map([[1, 9]]), 20);
    expect(once.starts[1]).toBe(9);
    const twice = solveStarts(cues, [0, 5], new Map([[1, 11]]), 20);
    expect(twice.starts[1]).toBe(11);
  });

  it('非法固定点参数按不可行处理（防御）', () => {
    const cues = mkCues([0, 5], [2, 2]);
    expect(solveStarts(cues, [0, 5], new Map([[1, DAY_MS + 1]])).feasible).toBe(false);
    expect(solveStarts(cues, [0, 5], new Map([[-1, 0] as unknown as [number, number]])).feasible).toBe(false);
  });
});

// ---------- 导入校验 ----------

describe('parseCues', () => {
  const valid = JSON.stringify({
    cues: [
      { start: 0, duration: 1, text: 'a' },
      { start: 86_400_000, duration: 60_000, text: 'b' },
    ],
  });

  it('合法文档', () => {
    const r = parseCues(valid);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cues).toHaveLength(2);
  });

  it.each([
    ['空串', ''],
    ['语法错误', '{cues: []}'],
    ['根为数组', '[]'],
    ['根为 null', 'null'],
    ['多余顶层键', '{"cues":[],"x":1}'],
    ['cues 非数组', '{"cues":{}}'],
    ['空 cues', '{"cues":[]}'],
    ['cue 多余键', '{"cues":[{"start":0,"duration":1,"text":"a","x":1}]}'],
    ['cue 缺键', '{"cues":[{"start":0,"duration":1}]}'],
    ['start 非整数', '{"cues":[{"start":0.5,"duration":1,"text":"a"}]}'],
    ['start 越界', '{"cues":[{"start":-1,"duration":1,"text":"a"}]}'],
    ['duration 为 0', '{"cues":[{"start":0,"duration":0,"text":"a"}]}'],
    ['duration 超限', '{"cues":[{"start":0,"duration":60001,"text":"a"}]}'],
    ['text 为空', '{"cues":[{"start":0,"duration":1,"text":""}]}'],
    ['text 非字符串', '{"cues":[{"start":0,"duration":1,"text":1}]}'],
    ['start 未严格递增', '{"cues":[{"start":5,"duration":1,"text":"a"},{"start":5,"duration":1,"text":"b"}]}'],
    ['元素为 null', '{"cues":[null]}'],
  ])('非法：%s', (_name, text) => {
    expect(parseCues(text).ok).toBe(false);
  });

  it('text 长 201 拒绝、200 接受', () => {
    const long = 'x'.repeat(201);
    const ok200 = 'y'.repeat(200);
    expect(parseCues(JSON.stringify({ cues: [{ start: 0, duration: 1, text: long }] })).ok).toBe(false);
    expect(parseCues(JSON.stringify({ cues: [{ start: 0, duration: 1, text: ok200 }] })).ok).toBe(true);
  });

  it('超过 20000 项拒绝', () => {
    const cues = Array.from({ length: 20001 }, (_, i) => ({ start: i * 2, duration: 1, text: 't' }));
    expect(parseCues(JSON.stringify({ cues })).ok).toBe(false);
  });
});

// ---------- 下载同结构 ----------

describe('buildDocument', () => {
  it('保留 duration 与 text，替换 start', () => {
    const cues = mkCues([0, 10], [5, 7]);
    const doc = JSON.parse(buildDocument(cues, [3, 11]));
    expect(doc.cues).toEqual([
      { start: 3, duration: 5, text: 'c0' },
      { start: 11, duration: 7, text: 'c1' },
    ]);
  });
});

// ---------- 性能：两万项，仅计求解函数，两秒内 ----------

describe('性能', () => {
  it('20000 项强重叠序列（巨型合并块）求解 < 2000ms', () => {
    const n = 20_000;
    const starts: number[] = new Array(n);
    const durations: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      starts[i] = i * 2500; // 严格递增但间隔小于时长 -> 全重叠
      durations[i] = 3000;
    }
    const cues = mkCues(starts, durations);
    const pins = new Map<number, number>([
      [0, 0],
      [5000, 15_000_000],
      [19999, 59_997_000],
    ]);
    const t0 = performance.now();
    const got = solveStarts(cues, starts, pins);
    const elapsed = performance.now() - t0;
    expect(got.feasible).toBe(true);
    assertValid(cues, got.starts, pins, DAY_MS);
    // eslint-disable-next-line no-console
    console.log(`强重叠 20000 项耗时 ${elapsed.toFixed(1)} ms，总位移 ${got.cost}`);
    expect(elapsed).toBeLessThan(2000);
  });

  it('20000 项随机合法序列求解 < 2000ms', () => {
    const rnd = mulberry32(42);
    const n = 20_000;
    // 合法严格递增起点：均匀步长铺到全天 70%，保证自身可行
    const compact: number[] = new Array(n);
    const durations: number[] = new Array(n);
    const slot = Math.floor((DAY_MS * 0.7) / n);
    for (let i = 0; i < n; i++) {
      compact[i] = i * slot;
      durations[i] = 1 + Math.floor(rnd() * (slot - 1)); // 小于步长
    }
    const cues = mkCues(compact, durations);
    // 采纳稿做小幅随机扰动（制造需要求解的位移），保持可行
    const baseline = compact.slice();
    for (let i = 1; i < n; i++) {
      const jitter = Math.floor(rnd() * slot * 0.8) - Math.floor(slot * 0.4);
      baseline[i] = Math.max(
        baseline[i - 1] + durations[i - 1],
        Math.min(compact[i] + jitter, DAY_MS),
      );
    }
    const pins = new Map<number, number>();
    for (let i = 100; i < n; i += 1500) pins.set(i, compact[i]);
    const t0 = performance.now();
    const got = solveStarts(cues, baseline, pins);
    const elapsed = performance.now() - t0;
    expect(got.feasible).toBe(true);
    assertValid(cues, got.starts, pins, DAY_MS);
    // eslint-disable-next-line no-console
    console.log(`随机 20000 项耗时 ${elapsed.toFixed(1)} ms，总位移 ${got.cost}`);
    expect(elapsed).toBeLessThan(2000);
  });
});
