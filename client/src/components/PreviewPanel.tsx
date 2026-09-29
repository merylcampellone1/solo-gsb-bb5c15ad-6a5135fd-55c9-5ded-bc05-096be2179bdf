import type { ChangeItem, PreviewResult } from '../types';
import HighlightedText from './HighlightedText';

function groupChanges(changes: ChangeItem[]) {
  const groups = new Map<string, { from: number; to: number; items: ChangeItem[] }>();
  for (const c of changes) {
    const key = `${c.fromNumber}->${c.toNumber}`;
    if (!groups.has(key)) groups.set(key, { from: c.fromNumber, to: c.toNumber, items: [] });
    groups.get(key)!.items.push(c);
  }
  return [...groups.values()].sort((a, b) => a.from - b.from);
}

export default function PreviewPanel({ preview }: { preview: PreviewResult }) {
  const targets = new Set(preview.changes.map((c) => c.toNumber));
  const groups = groupChanges(preview.changes);

  return (
    <section className="card">
      <h3>逐处变更预览（{preview.changeCount} 处）</h3>
      <p className="muted small">
        以下为全部待写入的改动。确认提交前不会改动任何内容；提交时标题与正文引用在同一数据库事务中原子更新。
      </p>

      <div className="change-groups">
        {groups.map((g) => (
          <div key={`${g.from}-${g.to}`} className="change-group">
            <h4>
              第{g.from}条 <span className="arrow">→</span> 第{g.to}条
              <span className="muted small">（{g.items.length} 处）</span>
            </h4>
            <table className="data-table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>位置</th>
                  <th>改动</th>
                  <th>上下文</th>
                </tr>
              </thead>
              <tbody>
                {g.items.map((c, i) => (
                  <tr key={i}>
                    <td>
                      <span className={`kind kind-${c.kind}`}>
                        {c.kind === 'definition' ? '标题' : '引用'}
                      </span>
                    </td>
                    <td>
                      {c.line}:{c.column}
                    </td>
                    <td className="num">
                      <del>{c.before}</del> <span className="arrow">→</span>{' '}
                      <strong className="after">{c.after}</strong>
                    </td>
                    <td className="ellipsis">{c.snippet}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      <details>
        <summary>查看改号后的全文（高亮本次变更）</summary>
        <HighlightedText text={preview.previewText} targets={targets} />
      </details>
    </section>
  );
}
