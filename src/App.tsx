import { useCallback, useMemo, useRef, useState } from 'react';
import {
  buildDocument,
  Cue,
  DAY_MS,
  formatTime,
  parseCues,
  solveStarts,
} from './lib/cues';

type Preview = {
  starts: number[];
  cost: number;
};

const PAGE_SIZE = 100;

export default function App(): JSX.Element {
  // 最近一次合法导入的卷
  const [cues, setCues] = useState<Cue[]>([]);
  // 已采纳稿（基线）
  const [baseline, setBaseline] = useState<number[]>([]);
  const [fileName, setFileName] = useState<string>('');
  // cueIndex -> 固定起点（重复编辑覆盖，删除即解除）
  const [pins, setPins] = useState<Map<number, number>>(new Map());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<'INVALID_CUES' | 'INFEASIBLE' | null>(null);
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<{ index: number; value: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const hasWork = cues.length > 0;

  const loadText = useCallback(
    (text: string, name: string) => {
      const result = parseCues(text);
      if (!result.ok) {
        // 非法导入：清旧预览，保留最近合法工作稿
        setError('INVALID_CUES');
        setPreview(null);
        return;
      }
      const nextCues = result.cues;
      const nextBaseline = nextCues.map((c) => c.start);
      setCues(nextCues);
      setBaseline(nextBaseline);
      setFileName(name);
      setPins(new Map());
      setPreview(null);
      setError(null);
      setPage(0);
      setEditing(null);
    },
    [],
  );

  const onFile = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => loadText(String(reader.result ?? ''), file.name);
      reader.readAsText(file);
    },
    [loadText],
  );

  const generatePreview = useCallback(() => {
    if (cues.length === 0) return;
    const result = solveStarts(cues, baseline, pins);
    if (!result.feasible) {
      // 不可行：清旧预览
      setError('INFEASIBLE');
      setPreview(null);
      return;
    }
    setError(null);
    setPreview({ starts: result.starts, cost: result.cost });
  }, [cues, baseline, pins]);

  // 采纳：预览结果成为下一轮基线；固定点保留，位移标记归零
  const adopt = useCallback(() => {
    if (!preview) return;
    setBaseline(preview.starts);
    setPreview(null);
  }, [preview]);

  const download = useCallback(() => {
    if (cues.length === 0) return;
    const blob = new Blob([buildDocument(cues, baseline)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName ? fileName.replace(/\.json$/i, '') + '.adopted.json' : 'cues.adopted.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [cues, baseline, fileName]);

  const savePin = (index: number, raw: string): void => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > DAY_MS) return;
    setPins((prev) => {
      const next = new Map(prev);
      next.set(index, value); // 重复编辑覆盖旧值
      return next;
    });
    setEditing(null);
  };

  const removePin = (index: number): void => {
    setPins((prev) => {
      if (!prev.has(index)) return prev;
      const next = new Map(prev);
      next.delete(index); // 删除即解除固定
      return next;
    });
  };

  const pageCount = Math.max(1, Math.ceil(cues.length / PAGE_SIZE));
  const rowStart = page * PAGE_SIZE;
  const rows = useMemo(() => cues.slice(rowStart, rowStart + PAGE_SIZE), [cues, rowStart]);

  return (
    <div className="app">
      <header>
        <h1>字幕固定与重叠消除</h1>
        <p className="hint">
          纪录片补录后：锁定少数字幕起点，自动消除相邻重叠，最小化相对已采纳稿的绝对位移。
        </p>
      </header>

      <section className="toolbar">
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            onFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <button onClick={() => fileRef.current?.click()} disabled={false}>
          导入 JSON
        </button>
        <button onClick={generatePreview} disabled={!hasWork}>
          生成预览
        </button>
        <button className="primary" onClick={adopt} disabled={!preview}>
          采纳
        </button>
        <button onClick={download} disabled={!hasWork}>
          下载同结构 JSON
        </button>
        {hasWork && (
          <span className="meta">
            {fileName || '工作稿'} · {cues.length} 条 · 固定 {pins.size} 处
          </span>
        )}
      </section>

      {error === 'INVALID_CUES' && (
        <div className="error">INVALID_CUES：导入文件结构非法，已忽略；当前仍显示最近合法工作稿。</div>
      )}
      {error === 'INFEASIBLE' && <div className="error">INFEASIBLE：固定点与边界/不重叠约束冲突，无可行解，预览已清空。</div>}

      {preview && (
        <div className="banner">
          预览：总位移 <strong>{preview.cost.toLocaleString()}</strong> 毫秒
          {preview.cost === 0 && <span className="ok">（与已采纳稿一致）</span>}
        </div>
      )}

      {hasWork ? (
        <table>
          <thead>
            <tr>
              <th className="col-idx">#</th>
              <th className="col-time">已采纳起点</th>
              <th className="col-time">预览起点</th>
              <th>位移</th>
              <th className="col-pin">固定点 (0–{DAY_MS.toLocaleString()})</th>
              <th>text</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((cue, offset) => {
              const i = rowStart + offset;
              const pin = pins.get(i);
              const shown = preview ? preview.starts[i] : baseline[i];
              const delta = preview ? preview.starts[i] - baseline[i] : 0;
              return (
                <tr key={i} className={delta !== 0 ? 'moved' : undefined}>
                  <td className="col-idx">{i}</td>
                  <td className="mono">{formatTime(baseline[i])}</td>
                  <td className="mono">{formatTime(shown)}</td>
                  <td className={'delta ' + (delta > 0 ? 'pos' : delta < 0 ? 'neg' : 'zero')}>
                    {preview ? (delta > 0 ? `+${delta}` : `${delta}`) : '—'}
                  </td>
                  <td className="col-pin">
                    {pin !== undefined ? (
                      <span className="pin">
                        <span className="pin-val">{pin}</span>
                        <button className="mini" onClick={() => setEditing({ index: i, value: String(pin) })}>
                          编辑
                        </button>
                        <button className="mini" onClick={() => removePin(i)}>
                          解除
                        </button>
                      </span>
                    ) : (
                      <button className="mini" onClick={() => setEditing({ index: i, value: '' })}>
                        + 固定
                      </button>
                    )}
                    {editing?.index === i && (
                      <span className="pin-edit">
                        <input
                          autoFocus
                          value={editing.value}
                          onChange={(e) => setEditing({ index: i, value: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') savePin(i, editing.value);
                            if (e.key === 'Escape') setEditing(null);
                          }}
                          placeholder="整数毫秒"
                        />
                        <button className="mini" onClick={() => savePin(i, editing.value)}>
                          确定
                        </button>
                        <button className="mini" onClick={() => setEditing(null)}>
                          取消
                        </button>
                      </span>
                    )}
                  </td>
                  <td className="text-cell" title={cue.text}>
                    <span className="dur">{cue.duration}ms</span> {cue.text}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="empty">尚无合法工作稿，请导入根对象为 {'{" cues ": [...]}'} 的 JSON 文件。</p>
      )}

      {hasWork && pageCount > 1 && (
        <nav className="pager">
          <button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            上一页
          </button>
          <span>
            {page + 1} / {pageCount}
          </span>
          <button disabled={page >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}>
            下一页
          </button>
        </nav>
      )}
    </div>
  );
}
