import { useMemo, useState } from 'react';
import type { DiffStatus, VersionDiff } from '../types';

// 版本对照面板（只读）：
//   - 顶部给出新增 / 删除 / 内容修改 / 仅改号 / 无变化 / 待确认的数量；
//   - “待确认”分组单独列出（重复内容或同号多候选），不擅自归类；
//   - 结果按条款逐行展示两版编号、标题与原文片段；
//   - 可按状态筛选；不提供任何写入入口。

type FilterKey = DiffStatus | 'ambiguous';

const STATUS_LABEL: Record<DiffStatus, string> = {
  added: '新增',
  removed: '删除',
  modified: '内容修改',
  renumbered: '仅改号',
  unchanged: '无变化',
};

const STATUS_CLASS: Record<DiffStatus, string> = {
  added: 'diff-added',
  removed: 'diff-removed',
  modified: 'diff-modified',
  renumbered: 'diff-renumbered',
  unchanged: 'diff-unchanged',
};

function clauseCell(side: '旧稿' | '新稿', c: VersionDiff['pairs'][number]['old']) {
  if (!c) {
    return <td className="diff-empty muted">—</td>;
  }
  return (
    <td>
      <div className="diff-clause">
        <span className="num diff-num">
          {side} · 第{c.number}条
        </span>
        <span className="diff-title">{c.heading}</span>
        <span className="muted small">（第 {c.headingLine} 行）</span>
        <pre className="diff-snippet">{c.snippet}</pre>
      </div>
    </td>
  );
}

export default function VersionDiffPanel({ diff }: { diff: VersionDiff }) {
  const filters = useMemo<FilterKey[]>(
    () => ['added', 'removed', 'modified', 'renumbered', 'unchanged', 'ambiguous'],
    [],
  );
  const [active, setActive] = useState<Set<FilterKey>>(
    () => new Set<FilterKey>(['added', 'removed', 'modified', 'renumbered', 'ambiguous']),
  );

  const toggle = (k: FilterKey) => {
    const next = new Set(active);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setActive(next);
  };

  const visiblePairs = diff.pairs.filter((p) => active.has(p.status));
  const showAmbiguous = active.has('ambiguous');

  const countBadge = (k: FilterKey, n: number) => (
    <button
      key={k}
      type="button"
      className={`diff-filter ${active.has(k) ? 'is-on' : ''} ${
        k === 'ambiguous' ? 'diff-filter-amb' : `diff-filter-${k}`
      }`}
      onClick={() => toggle(k)}
      aria-pressed={active.has(k)}
    >
      {k === 'ambiguous' ? '待确认' : STATUS_LABEL[k as DiffStatus]} · {n}
    </button>
  );

  return (
    <section className="card">
      <h3>版本对照结果（只读，不改动当前文档与撤销历史）</h3>
      <p className="muted small">
        以已保存合同为旧稿（{diff.oldClauseCount} 条）、粘贴文本为新稿（
        {diff.newClauseCount} 条）：按标题边界拆分后，先以去编号、规范空白后的内容唯一匹配跨编号条款，
        再对剩余条款按唯一同号配对；内容或编号重复形成多候选的一律列为“待确认”，不自动归类。
      </p>

      {(diff.oldIssues.length > 0 || diff.newIssues.length > 0) && (
        <div className="issue issue-missing small" style={{ marginBottom: 10 }}>
          ⚠️{' '}
          {diff.oldIssues.length > 0 &&
            `旧稿存在 ${diff.oldIssues.length} 处重复定义/缺失引用；`}
          {diff.newIssues.length > 0 &&
            `新稿存在 ${diff.newIssues.length} 处重复定义/缺失引用；`}
          标题边界可能不唯一，请结合原文核对对照结果。
        </div>
      )}

      <div className="diff-filters">
        {countBadge('added', diff.counts.added)}
        {countBadge('removed', diff.counts.removed)}
        {countBadge('modified', diff.counts.modified)}
        {countBadge('renumbered', diff.counts.renumbered)}
        {countBadge('unchanged', diff.counts.unchanged)}
        {diff.ambiguous.length > 0 && countBadge('ambiguous', diff.ambiguous.length)}
      </div>

      {showAmbiguous && diff.ambiguous.length > 0 && (
        <div className="diff-ambiguous-box">
          <h4>待确认（{diff.ambiguous.length} 组，未参与自动配对）</h4>
          {diff.ambiguous.map((g, i) => (
            <div key={i} className="diff-amb-group">
              <div className="diff-amb-msg">
                <span className="tag tag-warn">
                  {g.reason === 'duplicate_content' ? '重复内容多候选' : '同号多候选'}
                </span>
                {g.number !== null && <span className="num"> 第{g.number}条</span>}
                <span className="muted small"> {g.message}</span>
              </div>
              <div className="diff-amb-cols">
                <div>
                  <div className="muted small">旧稿候选（{g.old.length}）</div>
                  <ul>
                    {g.old.map((c, j) => (
                      <li key={j}>
                        <span className="num">第{c.number}条</span> {c.heading}
                        <span className="muted small">（第 {c.headingLine} 行）</span>
                      </li>
                    ))}
                    {g.old.length === 0 && <li className="muted small">无（将计为新增）</li>}
                  </ul>
                </div>
                <div>
                  <div className="muted small">新稿候选（{g.new.length}）</div>
                  <ul>
                    {g.new.map((c, j) => (
                      <li key={j}>
                        <span className="num">第{c.number}条</span> {c.heading}
                        <span className="muted small">（第 {c.headingLine} 行）</span>
                      </li>
                    ))}
                    {g.new.length === 0 && <li className="muted small">无（将计为删除）</li>}
                  </ul>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <table className="data-table diff-table">
        <thead>
          <tr>
            <th style={{ width: 90 }}>状态</th>
            <th>旧稿条款（已保存合同）</th>
            <th>新稿条款（粘贴文本）</th>
          </tr>
        </thead>
        <tbody>
          {visiblePairs.map((p, i) => {
            const label =
              p.status === 'unchanged'
                ? '无变化'
                : STATUS_LABEL[p.status];
            return (
              <tr key={i} className={STATUS_CLASS[p.status]}>
                <td>
                  <span className={`kind diff-kind diff-kind-${p.status}`}>{label}</span>
                </td>
                {clauseCell('旧稿', p.old)}
                {clauseCell('新稿', p.new)}
              </tr>
            );
          })}
          {visiblePairs.length === 0 && (
            <tr>
              <td colSpan={3} className="muted small" style={{ textAlign: 'center' }}>
                当前筛选条件下没有条款。
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
