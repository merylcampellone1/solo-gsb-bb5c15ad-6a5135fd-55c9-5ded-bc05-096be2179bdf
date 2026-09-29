import type { RemovalPreviewResult } from '../types';
import HighlightedText from './HighlightedText';

// 条款裁撤预览：先列“删除区块”（行范围、相邻标题、将删除的完整文本），
// 再列逐处引用替换，最后给出可展开的结果全文（高亮替代目标编号）。

export default function RemovalPreview({ preview }: { preview: RemovalPreviewResult }) {
  const targets = new Set(preview.replacements.map((r) => r.to));

  return (
    <section className="card">
      <h3>
        裁撤预览：删除 {preview.deleteCount} 个条款区块
        {preview.changeCount > 0 && `，改写 ${preview.changeCount} 处引用`}
      </h3>
      <p className="muted small">
        以下为全部待写入改动。确认提交前不改动任何内容；提交时正文更新与撤销历史在同一 SQLite 事务中原子完成。
      </p>

      <h4>删除区块（{preview.blocks.length}）</h4>
      <table className="data-table">
        <thead>
          <tr>
            <th>条款</th>
            <th>删除行范围</th>
            <th>相邻标题</th>
            <th>将删除的文本</th>
          </tr>
        </thead>
        <tbody>
          {preview.blocks.map((b) => (
            <tr key={b.number} className="row-missing">
              <td className="num">
                <del>第{b.number}条</del>
              </td>
              <td className="num">
                第 {b.startLine} 行 – 第 {b.endLine} 行
              </td>
              <td className="small">
                {b.prev ? (
                  <div>
                    ↑ 第{b.prev.number}条（第 {b.prev.headingLine} 行）
                  </div>
                ) : (
                  <div className="muted">↑ 文首序言</div>
                )}
                {b.next ? (
                  <div>
                    ↓ 第{b.next.number}条（第 {b.next.headingLine} 行）
                  </div>
                ) : (
                  <div className="muted">↓ 文末</div>
                )}
              </td>
              <td>
                <pre className="removed-snippet">{b.removedText.trimEnd()}</pre>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>逐处引用替换（{preview.changes.length}）</h4>
      {preview.changes.length === 0 ? (
        <p className="muted small">无需改写引用：待删条款没有被幸存文本引用。</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>所在条款</th>
              <th>位置</th>
              <th>改动</th>
              <th>上下文</th>
            </tr>
          </thead>
          <tbody>
            {preview.changes.map((c, i) => (
              <tr key={i}>
                <td>{c.ownerNumber === null ? '序言' : `第${c.ownerNumber}条`}</td>
                <td className="num">
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
      )}

      <details>
        <summary>查看裁撤后的全文（高亮替代目标编号）</summary>
        <HighlightedText text={preview.previewText} targets={targets} />
      </details>
    </section>
  );
}
