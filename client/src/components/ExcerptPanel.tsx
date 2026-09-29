import { useMemo, useState } from 'react';
import { api } from '../api';
import type {
  AnalyzeDTO,
  ExcerptConflict,
  ExcerptError,
  ExcerptResult,
} from '../types';

// 条款摘录面板（只读）：
//   - 勾选一个或多个已定义条款作为摘录起点；
//   - 后端沿区块正文中的“第X条”引用递归收齐：循环只收录一次、按原文顺序拼接，
//     逐字保留标题行与正文（含原编号），不带入未引用条款与序言；
//   - 所选/可达编号重复标题、可达引用指向未定义编号、空选择、起点未定义都会
//     被后端拒绝（409），这里原样标出冲突编号、标题行与引用位置；
//   - 整个过程只读，不修改文档与撤销历史。

export interface ExcerptPanelProps {
  docId: number;
  analysis: AnalyzeDTO;
}

export default function ExcerptPanel({ docId, analysis }: ExcerptPanelProps) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<ExcerptResult | null>(null);
  const [conflicts, setConflicts] = useState<ExcerptConflict[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const selectedList = useMemo(
    () => analysis.definitions.filter((d) => selected.has(d.number)).map((d) => d.number),
    [analysis.definitions, selected],
  );

  const toggle = (n: number) => {
    const next = new Set(selected);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    setSelected(next);
    // 选择变化后旧结果/冲突失效
    setResult(null);
    setConflicts([]);
    setErrorMsg('');
    setCopied(false);
  };

  const generate = async () => {
    if (selected.size === 0) {
      setResult(null);
      setConflicts([]);
      setErrorMsg('请先勾选至少一个条款作为摘录起点。');
      return;
    }
    setLoading(true);
    setConflicts([]);
    setErrorMsg('');
    setCopied(false);
    try {
      const { excerpt } = await api.excerpt(docId, [...selected].sort((a, b) => a - b));
      setResult(excerpt);
    } catch (e) {
      const err = e as ExcerptError;
      setResult(null);
      setConflicts(err.conflicts ?? []);
      if (err.conflicts.length === 0) setErrorMsg(err.message);
    } finally {
      setLoading(false);
    }
  };

  const copyText = async () => {
    if (!result) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(result.text);
      } else {
        // 非安全上下文（http）兜底：临时文本域 + execCommand
        const ta = document.createElement('textarea');
        ta.value = result.text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
    } catch {
      setErrorMsg('浏览器拒绝了剪贴板访问，请手动选择文本框内容复制。');
    }
  };

  return (
    <section className="card">
      <h3>条款摘录：勾选起点，沿“第X条”引用递归收齐</h3>
      <p className="muted small">
        勾选一个或多个条款作为摘录起点，系统沿所选条款正文中的引用<strong>递归收齐</strong>
        被引用条款：循环引用只收录一次，结果<strong>按原文顺序</strong>排列并逐字保留各区块标题行、
        正文与原有编号；未被引用的条款及首个标题之前的序言不会进入摘录。过程<strong>只读</strong>，
        不修改当前文档、不写入撤销历史。
      </p>

      <table className="data-table">
        <thead>
          <tr>
            <th style={{ width: 40 }}>摘录</th>
            <th>编号</th>
            <th>标题（所在行）</th>
            <th>行</th>
          </tr>
        </thead>
        <tbody>
          {analysis.definitions.map((d) => (
            <tr key={d.number}>
              <td>
                <input
                  type="checkbox"
                  checked={selected.has(d.number)}
                  onChange={() => toggle(d.number)}
                  aria-label={`摘录第${d.number}条`}
                />
              </td>
              <td className="num">第{d.number}条</td>
              <td className="ellipsis">{d.heading}</td>
              <td>{d.headingLine}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row-actions">
        <span className="muted small">已选 {selectedList.length} 条起点</span>
        <div className="spacer" />
        <button
          type="button"
          className="btn btn-primary"
          onClick={generate}
          disabled={loading || selectedList.length === 0}
        >
          {loading ? '收集中…' : '生成摘录'}
        </button>
      </div>

      {errorMsg && (
        <div className="issue issue-missing small" role="alert">
          {errorMsg}
        </div>
      )}

      {conflicts.length > 0 && (
        <div className="conflicts excerpt-conflicts" role="alert">
          <h4>⚠️ 已拒绝生成摘录（{conflicts.length} 项问题，未改动任何内容）</h4>
          <ul>
            {conflicts.map((c, i) => (
              <li key={i}>
                <code className="conflict-code">{c.code}</code> {c.message}
                {c.headings && c.headings.length > 0 && (
                  <ul className="conflict-sub">
                    {c.headings.map((h, j) => (
                      <li key={j}>
                        <span className="pos-chip">第 {h.pos.line} 行</span>
                        <span className="ellipsis inline">{h.heading}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {c.references && c.references.length > 0 && (
                  <ul className="conflict-sub">
                    {c.references.map((r, j) => (
                      <li key={j}>
                        <span className="pos-chip">
                          第 {r.pos.line} 行第 {r.pos.column} 列
                        </span>
                        <span className="muted small">（位于第{r.ownerNumber}条区块）</span>{' '}
                        <span className="ellipsis inline">{r.line}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result && (
        <div className="impact-box excerpt-result">
          <h4>
            摘录结果（共 {result.count} 条：起点{' '}
            {result.clauses.filter((c) => c.seed).length} 条，沿引用收齐{' '}
            {result.clauses.filter((c) => !c.seed).length} 条）
          </h4>
          <ul className="chip-list">
            {result.clauses.map((c) => (
              <li key={c.number}>
                {c.seed ? (
                  <span className="tag tag-ok">起点 第{c.number}条</span>
                ) : (
                  <span className="tag tag-warn">引用收齐 第{c.number}条</span>
                )}
                <span className="muted small ellipsis inline">
                  {c.heading}（第 {c.headingLine}–{c.endLine} 行）
                </span>
              </li>
            ))}
          </ul>
          <div className="row-actions">
            <span className="muted small">下方为可复制的纯文本（按原文顺序拼接）</span>
            <div className="spacer" />
            <button type="button" className="btn" onClick={copyText}>
              {copied ? '✅ 已复制到剪贴板' : '📋 复制摘录文本'}
            </button>
          </div>
          <textarea className="contract-view excerpt-text" readOnly rows={16} value={result.text} />
        </div>
      )}
    </section>
  );
}
