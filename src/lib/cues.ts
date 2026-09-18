// 字幕校验、求解与格式化
//
// 求解模型
// --------
// 设采纳稿起点为 b_i，本卷 durations 为 d_i，累计前缀 A_0=0, A_{i+1}=A_i+d_i。
// 作变量代换 z_i = x_i - A_i，则：
//   - 相邻不重叠 x_{i+1} >= x_i + d_i  <=>  z_{i+1} >= z_i（保序）
//   - 0 <= x_i <= DAY                  <=>  -A_i <= z_i <= DAY - A_i
//   - 固定点 x_i = v                   <=>  z_i = v - A_i
//   - 目标 Σ|x_i - b_i|               =  Σ|z_i - (b_i - A_i)|
// 即带逐点区间与固定点的整数 L1 保序回归。
//
// 用斜率技巧（左大根堆 L / 右小根堆 R）逐列扫描，每步加入 |z - w_i|、
// 施加下界墙与上界墙、记录最小最优值 s_i 并清空 R（前缀 min）。
// 反向重建 z_i = min(s_i, z_{i+1}) 即分量最小（按 cue 顺序字典序最小）的最优整数向量。

export const DAY_MS = 86_400_000;
export const MAX_CUES = 20_000;
export const MAX_DURATION = 60_000;
export const MAX_TEXT_LEN = 200;

export interface Cue {
  readonly start: number;
  readonly duration: number;
  readonly text: string;
}

export type CueDocument = { readonly cues: readonly Cue[] };

export type ParseResult =
  | { readonly ok: true; readonly cues: Cue[] }
  | { readonly ok: false };

function isInt(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** 严格校验导入 JSON：根对象仅含 cues；每项仅含整数 start/duration 与字符串 text。 */
export function parseCues(jsonText: string): ParseResult {
  let root: unknown;
  try {
    root = JSON.parse(jsonText);
  } catch {
    return { ok: false };
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    return { ok: false };
  }
  const record = root as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record.cues)) {
    return { ok: false };
  }
  const rawCues = record.cues as unknown[];
  if (rawCues.length < 1 || rawCues.length > MAX_CUES) {
    return { ok: false };
  }
  const cues: Cue[] = new Array(rawCues.length);
  let prevStart = -1;
  for (let i = 0; i < rawCues.length; i++) {
    const item = rawCues[i];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false };
    }
    const cue = item as Record<string, unknown>;
    const keys = Object.keys(cue);
    if (keys.length !== 3) {
      return { ok: false };
    }
    const { start, duration, text } = cue;
    if (!isInt(start, 0, DAY_MS) || !isInt(duration, 1, MAX_DURATION) || typeof text !== 'string') {
      return { ok: false };
    }
    if (text.length < 1 || text.length > MAX_TEXT_LEN) {
      return { ok: false };
    }
    if (i > 0 && (start as number) <= prevStart) {
      return { ok: false };
    }
    prevStart = start as number;
    cues[i] = { start: start as number, duration: duration as number, text };
  }
  return { ok: true, cues };
}

export interface SolveResult {
  readonly feasible: boolean;
  /** 新起点向量；不可行时为空数组。 */
  readonly starts: number[];
  /** 最优总位移 Σ|x_i - b_i|；不可行时为 0。 */
  readonly cost: number;
}

/**
 * L1 保序求解。
 * @param cues     当前卷（durations 决定相邻间隔）
 * @param baseline 已采纳稿起点（长度与 cues 相同）
 * @param pins     cueIndex -> 固定整数起点（0..DAY_MS），每索引至多一个
 */
export function solveStarts(
  cues: readonly Cue[],
  baseline: readonly number[],
  pins: ReadonlyMap<number, number>,
  dayMs: number = DAY_MS,
): SolveResult {
  const n = cues.length;

  // 固定点合法性防御（界面已约束）
  for (const [idx, value] of pins) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= n || !Number.isInteger(value) || value < 0 || value > dayMs) {
      return { feasible: false, starts: [], cost: 0 };
    }
  }

  // 前缀累计时长（int32：最多 20000*60000 = 1.2e9）
  const A = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    A[i] = i === 0 ? 0 : A[i - 1] + cues[i - 1].duration;
  }

  // z 空间逐点盒子：l_i/u_i；下界取前缀最大值 L_i 供墙使用。
  const lEff = new Int32Array(n);
  const u = new Int32Array(n);
  let lo = 0;
  for (let i = 0; i < n; i++) {
    const pin = pins.get(i);
    if (pin !== undefined) lo = Math.max(lo, pin - A[i]);
    lEff[i] = lo;
  }
  let hi = dayMs; // 末尾之后按 +∞ 处理
  for (let i = n - 1; i >= 0; i--) {
    const pin = pins.get(i);
    if (pin !== undefined) hi = Math.min(hi, pin - A[i]);
    u[i] = Math.min(hi, dayMs - A[i]);
  }
  for (let i = 0; i < n; i++) {
    if (lEff[i] > u[i]) return { feasible: false, starts: [], cost: 0 };
  }

  // --- 斜率技巧双堆（手写二叉堆，值均在 int32 范围） ---
  const cap = 4 * n + 4;
  const L = new Int32Array(cap); // 左断点，大根堆
  const R = new Int32Array(cap); // 右断点，小根堆
  let lc = 0;
  let rc = 0;
  let f0 = 0;

  const pushL = (v: number): void => {
    let i = lc++;
    L[i] = v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (L[p] >= L[i]) break;
      const t = L[p]; L[p] = L[i]; L[i] = t;
      i = p;
    }
  };
  const pushR = (v: number): void => {
    let i = rc++;
    R[i] = v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (R[p] <= R[i]) break;
      const t = R[p]; R[p] = R[i]; R[i] = t;
      i = p;
    }
  };
  const popL = (): number => {
    const top = L[0];
    const last = L[--lc];
    if (lc > 0) {
      let i = 0;
      L[0] = last;
      for (;;) {
        const a = 2 * i + 1;
        const b = a + 1;
        let m = i;
        if (a < lc && L[a] > L[m]) m = a;
        if (b < lc && L[b] > L[m]) m = b;
        if (m === i) break;
        const t = L[m]; L[m] = L[i]; L[i] = t;
        i = m;
      }
    }
    return top;
  };
  const popR = (): number => {
    const top = R[0];
    const last = R[--rc];
    if (rc > 0) {
      let i = 0;
      R[0] = last;
      for (;;) {
        const a = 2 * i + 1;
        const b = a + 1;
        let m = i;
        if (a < rc && R[a] < R[m]) m = a;
        if (b < rc && R[b] < R[m]) m = b;
        if (m === i) break;
        const t = R[m]; R[m] = R[i]; R[i] = t;
        i = m;
      }
    }
    return top;
  };
  // f += (w - x)_+
  const addLeft = (w: number): void => {
    pushL(w);
    if (rc > 0 && R[0] < L[0]) {
      const x = popR();
      const y = popL();
      f0 += y - x;
      pushL(x);
      pushR(y);
    }
  };
  // f += (x - w)_+
  const addRight = (w: number): void => {
    pushR(w);
    if (rc > 0 && R[0] < L[0]) {
      const x = popR();
      const y = popL();
      f0 += y - x;
      pushL(x);
      pushR(y);
    }
  };
  // 硬墙 z >= l（当前步已保证 l <= u 且后续 l 不减）
  const applyLower = (l: number): void => {
    while (lc > 0 && L[0] < l) popL();
    while (rc > 0 && R[0] < l) {
      const b = popR();
      f0 += l - b;
      pushR(l);
    }
    if (lc === 0) pushL(l);
  };
  // 硬墙 z <= u
  const applyUpper = (u: number): void => {
    while (lc > 0 && L[0] > u) {
      const a = popL();
      f0 += a - u;
      pushL(u);
    }
    while (rc > 0 && R[0] > u) popR();
    if (rc === 0) pushR(u);
  };

  const s = new Int32Array(n);

  for (let i = 0; i < n; i++) {
    const w = baseline[i] - A[i];
    addLeft(w);
    addRight(w);
    applyLower(lEff[i]);
    applyUpper(u[i]);
    // 最小最优值（平顶左端）
    s[i] = rc > 0 && R[0] < L[0] ? R[0] : L[0];
    // 前缀 min：右断点整体清空
    rc = 0;
  }

  // 反向贪心：分量最小的最优解
  const z = new Int32Array(n);
  let next = Infinity;
  for (let i = n - 1; i >= 0; i--) {
    const v = Math.min(s[i], next);
    z[i] = v;
    next = v;
  }

  const starts = new Array<number>(n);
  for (let i = 0; i < n; i++) starts[i] = z[i] + A[i];
  return { feasible: true, starts, cost: f0 };
}

/** 毫秒 -> HH:MM:SS.mmm */
export function formatTime(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  const pad = (v: number, w = 2): string => v.toString().padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}.${pad(milli, 3)}`;
}

export function buildDocument(cues: readonly Cue[], starts: readonly number[]): string {
  const doc = {
    cues: cues.map((cue, i) => ({
      start: starts[i],
      duration: cue.duration,
      text: cue.text,
    })),
  };
  return JSON.stringify(doc, null, 2);
}
