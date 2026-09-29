import { useEffect, useMemo, useState } from 'react';
import type {
  AnalyzeDTO,
  RemovalImpact,
  RemovalReplacement,
} from '../types';

// 条款裁撤工作台：
//   - 勾选一个或多个已定义条款（标题复选框）；
//   - 调影响分析后展示：直接引用待删条款的位置、沿引用链传递受影响的条款；
//   - 每处直接引用按“被引待删编号”归组，必须选择一个未删除条款作为替代；
//   - 无引用的待删条款可直接裁撤。
// 真正的冲突判定以后端预览 409 为准，这里只做轻量禁用与提示。

export interface RemovalPanelProps {
  analysis: AnalyzeDTO;
  selected: Set<number>;
  onSelectChange: (next: Set<number>) => void;
  impact: RemovalImpact | null;
  loading: boolean;
  onAnalyze: () => void;
  replacements: RemovalReplacement[];
  onReplacementsChange: (rows: RemovalReplacement[]) => void;
  onPreview: () => void;
  hasPreview: boolean;
}

function formatPath(path: number[]): string {
  return path.map((n, i) => (i === 0 ? `第${n}条` : `→第${n}条`)).join('');
}

export default function RemovalPanel({
  analysis,
  selected,
  onSelectChange,
  impact,
  loading,
  onAnalyze,
  replacements,
  onReplacementsChange,
  onPreview,
  hasPreview,
}: RemovalPanelProps) {
  const [replacementSource, setReplacementSource] = useState<number | null>(null);

  const dupes = new Set(
    analysis.issues.filter((i) => i.kind === 'duplicate_definition').map((i) => i.number),
  );
  const missingNumbers = new Set(
    analysis.issues.filter((i) => i.kind === 'missing_reference').map((i) => i.number),
  );

  const selectedList = useMemo(
    () => analysis.definitions.filter((d) => selected.has(d.number)).map((d) => d.number),
    [analysis.definitions, selected],
  );

  // 需要指定替代的待删编号（幸存侧至少有一处引用）
  const mappingTargets = useMemo(() => {
    if (!impact) return [];
    return [...new Set(impact.directReferences.map((r) => r.number))].sort((a, b) => a - b);
  }, [impact]);

  const replacementByFrom = useMemo(
    () => new Map(replacements.map((r) => [r.from, r.to])),
    [replacements],
  );

  // 选择变化后，清理不再被需要的替代行
  useEffect(() => {
    if (replacements.length === 0) return;
    const kept = replacements.filter(
      (r) => selected.has(r.from) && mappingTargets.includes(r.from),
    );
    if (kept.length !== replacements.length) onReplacementsChange(kept);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, mappingTargets.join(',')]);

  const survivors = analysis.definedNumbers.filter((n) => !selected.has(n));

  const toggle = (n: number) => {
    const next = new Set(selected);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    onSelectChange(next);
  };

  const setReplacement = (from: number, to: number) => {
    const rest = replacements.filter((r) => r.from !== from);
    onReplacementsChange(to ? [...rest, { from, to }] : rest);
  };

  const allMapped =
    mappingTargets.length > 0 &&
    mappingTargets.every(
      (n) =>
        replacementByFrom.has(n) &&
        !selected.has(replacementByFrom.get(n)!),
    );
  const needMapping = mappingTargets.length;
  const canPreview =
    selectedList.length > 0 && (needMapping === 0 || allMapped);

  return (
    <section className="card">
      <h3>条款裁撤：勾选待删条款并指定引用替代</h3>
      <p className="muted small">
        系统按标题边界识别各条款正文并构建引用图：列出直接引用待删条款的位置，以及沿引用链传递受影响的幸存条款。
        每个指向待删条款的引用必须改指向一个<strong>未删除</strong>的已定义条款；没有任何引用的条款可直接裁撤。
      </p>

      {(dupes.size > 0 || missingNumbers.size > 0) && (
        <div className="issue issue-dup small" style={{ marginBottom: 10 }}>
          ⚠️ 当前文本存在重复定义或缺失引用，引用图不完整，裁撤提交会被拒绝（并返回行列位置）。
          请先通过改号/编辑原文消除后再裁撤。
        </div>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th style={{ width: 40 }}>裁撤</th>
            <th>编号</th>
            <th>标题（所在行）</th>
            <th>行</th>
            <th>出现总数</th>
          </tr>
        </thead>
        <tbody>
          {analysis.definitions.map((d) => {
            const isDup = dupes.has(d.number);
            return (
              <tr key={d.number} className={isDup ? 'row-dup' : ''}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(d.number)}
                    onChange={() => toggle(d.number)}
                    aria-label={`裁撤第${d.number}条`}
                  />
                </td>
                <td className="num">第{d.number}条</td>
                <td className="ellipsis">{d.heading}</td>
                <td>{d.headingLine}</td>
                <td>{d.occurrenceCount}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="row-actions">
        <button
          type="button"
          className="btn"
          onClick={onAnalyze}
          disabled={loading || selectedList.length === 0}
        >
          {loading ? '分析中…' : `分析引用影响（已选 ${selectedList.length} 条）`}
        </button>
        <div className="spacer" />
        <button
          type="button"
          className="btn btn-primary"
          onClick={onPreview}
          disabled={loading || !canPreview || !impact}
          title={!impact ? '请先分析引用影响' : canPreview ? '' : '尚有引用未指定未删除的替代条款'}
        >
          生成裁撤预览{hasPreview ? '（重新生成）' : ''}
        </button>
      </div>

      {impact && selectedList.length > 0 && (
        <div className="impact-box">
          <h4>删除集合（{impact.deletes.length}）</h4>
          <ul className="chip-list">
            {impact.deletes.map((d) => (
              <li key={d.number}>
                <span className="del-chip">第{d.number}条</span>
                <span className="muted small ellipsis inline">
                  {d.heading}（第 {d.headingLine} 行）
                </span>
                {d.unreferenced && <span className="tag tag-ok">无引用，可直接裁撤</span>}
                {!d.unreferenced && d.survivingRefCount === 0 && (
                  <span className="tag tag-ok">引用均在待删区块内，随区块移除</span>
                )}
                {d.survivingRefCount > 0 && (
                  <span className="tag tag-warn">
                    幸存正文 {d.survivingRefCount} 处引用待映射
                  </span>
                )}
              </li>
            ))}
          </ul>

          <h4>直接引用待删条款的位置（{impact.directReferences.length}）</h4>
          {impact.directReferences.length === 0 ? (
            <p className="muted small">幸存文本中没有任何指向待删条款的引用。</p>
          ) : (
            <>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>引用</th>
                    <th>所在条款</th>
                    <th>位置</th>
                    <th>上下文</th>
                  </tr>
                </thead>
                <tbody>
                  {impact.directReferences.map((r, i) => (
                    <tr key={i}>
                      <td className="num">第{r.number}条</td>
                      <td>{r.ownerNumber === null ? '序言（首个标题之前）' : `第${r.ownerNumber}条`}</td>
                      <td className="num">
                        {r.pos.line}:{r.pos.column}
                      </td>
                      <td className="ellipsis">{r.line}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="mapping-box">
                <h4>逐组指定替代条款</h4>
                {mappingTargets.map((from) => {
                  const val = replacementByFrom.get(from);
                  const ok = val !== undefined && !selected.has(val);
                  return (
                    <div key={from} className="replace-row"
                      onFocus={() => setReplacementSource(from)}
                      onMouseEnter={() => setReplacementSource(from)}
                    >
                      <span className="num">
                        <del>第{from}条</del>
                      </span>
                      <span className="arrow">→</span>
                      <select
                        value={val ?? ''}
                        onChange={(e) => setReplacement(from, Number(e.target.value))}
                        className={val !== undefined && !ok ? 'input-bad' : ''}
                      >
                        <option value="" disabled>
                          选择未删除条款…
                        </option>
                        {survivors.map((n) => (
                          <option key={n} value={n}>
                            第{n}条
                          </option>
                        ))}
                      </select>
                      {val !== undefined && !ok && (
                        <span className="field-hint bad">替代目标也在删除集合中</span>
                      )}
                      {ok && <span className="field-hint ok">已映射到第{val}条</span>}
                    </div>
                  );
                })}
                {replacementSource !== null && survivors.length === 0 && (
                  <p className="field-hint bad">没有可选的幸存条款：至少保留一个已定义条款作为替代目标。</p>
                )}
              </div>
            </>
          )}

          <h4>沿引用链传递受影响的条款（{impact.impacted.length}）</h4>
          {impact.impacted.length === 0 ? (
            <p className="muted small">没有其他条款沿引用链引用到待删集合。</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>条款</th>
                  <th>标题</th>
                  <th>影响方式</th>
                  <th>引用链</th>
                </tr>
              </thead>
              <tbody>
                {impact.impacted.map((c) => (
                  <tr key={c.number}>
                    <td className="num">第{c.number}条</td>
                    <td className="ellipsis">{c.heading}</td>
                    <td>{c.direct ? '直接引用' : '传递引用'}</td>
                    <td className="small">
                      {c.paths.map((p, i) => (
                        <div key={i} className="path-line">
                          {formatPath(p)}
                          {p[p.length - 1] !== undefined && <span className="muted"> （终点被裁撤）</span>}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
