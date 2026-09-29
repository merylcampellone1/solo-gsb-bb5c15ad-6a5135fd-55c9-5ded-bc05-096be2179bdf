import type { AnalyzeDTO } from '../types';

export interface MappingRow {
  id: number;
  from: string;
  to: string;
}

export default function MappingEditor({
  analysis,
  rows,
  onChange,
  onPreview,
  onCommit,
  loading,
  hasPreview,
}: {
  analysis: AnalyzeDTO;
  rows: MappingRow[];
  onChange: (rows: MappingRow[]) => void;
  onPreview: () => void;
  onCommit: () => void;
  loading: boolean;
  hasPreview: boolean;
}) {
  let seq = rows.reduce((m, r) => Math.max(m, r.id), 0);
  const addRow = () => onChange([...rows, { id: ++seq, from: '', to: '' }]);
  const update = (id: number, field: 'from' | 'to', value: string) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  const remove = (id: number) => onChange(rows.filter((r) => r.id !== id));

  const defined = analysis.definedNumbers;

  // 快速构造：交换两个编号、环形改号。
  const fillSwap = () => {
    if (defined.length < 2) return;
    const a = defined[0];
    const b = defined[1];
    onChange([
      { id: 1, from: String(a), to: String(b) },
      { id: 2, from: String(b), to: String(a) },
    ]);
  };
  const fillCycle = () => {
    if (defined.length < 3) return;
    const [a, b, c] = defined;
    onChange([
      { id: 1, from: String(a), to: String(b) },
      { id: 2, from: String(b), to: String(c) },
      { id: 3, from: String(c), to: String(a) },
    ]);
  };

  const toOptions = (value: string) => {
    const n = Number(value);
    const usedTargets = new Set(
      rows.filter((r) => r.from !== value && r.to.trim() !== '').map((r) => Number(r.to)),
    );
    return { n, usedTargets };
  };

  return (
    <section className="card">
      <h3>批量映射：旧编号 → 新编号</h3>
      <p className="muted small">
        支持交换、环形改号（如 1→2、2→3、3→1）与 1/10 等前缀相近编号——以完整“第X条”为单位逐处替换，不会误伤。
        目标编号撞上未参与改号的既有条款时会整体拒绝。
      </p>

      <div className="quick-actions">
        <button type="button" className="btn btn-ghost" onClick={fillSwap}>
          ⇄ 快速填入：交换前两个编号
        </button>
        <button type="button" className="btn btn-ghost" onClick={fillCycle}>
          ↻ 快速填入：前三个编号环形改号
        </button>
      </div>

      <table className="data-table mapping-table">
        <thead>
          <tr>
            <th>旧编号</th>
            <th></th>
            <th>新编号</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const { n, usedTargets } = toOptions(row.from);
            const fromKnown = row.from.trim() !== '' && defined.includes(n);
            const targetClash =
              row.to.trim() !== '' &&
              usedTargets.has(Number(row.to));
            return (
              <tr key={row.id}>
                <td>
                  <input
                    list="defined-numbers"
                    value={row.from}
                    placeholder="如 1"
                    onChange={(e) => update(row.id, 'from', e.target.value)}
                    className={row.from && !fromKnown ? 'input-bad' : ''}
                  />
                  {row.from && !fromKnown && (
                    <div className="field-hint bad">文本中无“第{row.from}条”标题</div>
                  )}
                </td>
                <td className="arrow">→</td>
                <td>
                  <input
                    value={row.to}
                    placeholder="如 2"
                    onChange={(e) => update(row.id, 'to', e.target.value)}
                    className={targetClash ? 'input-bad' : ''}
                  />
                  {targetClash && <div className="field-hint bad">新编号在映射内重复</div>}
                </td>
                <td>
                  <button type="button" className="btn btn-link-danger" onClick={() => remove(row.id)}>
                    删除
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <datalist id="defined-numbers">
        {defined.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>

      <div className="row-actions">
        <button type="button" className="btn" onClick={addRow}>
          ＋ 添加一行
        </button>
        <div className="spacer" />
        <button type="button" className="btn" onClick={onPreview} disabled={loading}>
          {loading ? '计算中…' : '生成变更预览'}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onCommit}
          disabled={loading || !hasPreview}
          title={hasPreview ? '' : '请先生成预览'}
        >
          确认并原子提交
        </button>
      </div>
    </section>
  );
}
