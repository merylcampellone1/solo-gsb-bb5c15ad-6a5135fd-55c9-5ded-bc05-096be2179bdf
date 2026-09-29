import type { AnalyzeDTO } from '../types';

export default function AnalysisPanel({ analysis }: { analysis: AnalyzeDTO }) {
  const dupes = analysis.issues.filter((i) => i.kind === 'duplicate_definition');
  const missing = analysis.issues.filter((i) => i.kind === 'missing_reference');
  const missingNumbers = new Set(missing.map((i) => i.number));

  return (
    <section className="card">
      <h3>解析结果</h3>
      <p className="muted">
        共识别 <strong>{analysis.totalOccurrences}</strong> 处“第X条”，
        定义 <strong>{analysis.definitions.length}</strong> 个编号，
        引用 <strong>{analysis.references.length}</strong> 处。
      </p>

      {analysis.issues.length > 0 && (
        <div className="issue-banner">
          {dupes.length > 0 && <span className="tag tag-dup">重复编号 ×{dupes.length}</span>}
          {missing.length > 0 && (
            <span className="tag tag-missing">缺失引用 ×{missing.length}</span>
          )}
        </div>
      )}

      {analysis.issues.length > 0 && (
        <div className="issue-list">
          {analysis.issues.map((issue, i) => (
            <div key={i} className={`issue ${issue.kind === 'duplicate_definition' ? 'issue-dup' : 'issue-missing'}`}>
              {issue.message}
            </div>
          ))}
        </div>
      )}

      <details open>
        <summary>条款定义（{analysis.definitions.length}）</summary>
        <table className="data-table">
          <thead>
            <tr>
              <th>编号</th>
              <th>标题（所在行）</th>
              <th>行</th>
              <th>出现总数</th>
            </tr>
          </thead>
          <tbody>
            {analysis.definitions.map((d) => {
              const isDup = dupes.some((x) => x.number === d.number);
              return (
                <tr key={d.number} className={isDup ? 'row-dup' : ''}>
                  <td className="num">第{d.number}条</td>
                  <td className="ellipsis">{d.heading}</td>
                  <td>{d.headingLine}</td>
                  <td>{d.occurrenceCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>

      <details open>
        <summary>条款引用（{analysis.references.length}）</summary>
        <table className="data-table">
          <thead>
            <tr>
              <th>引用</th>
              <th>位置</th>
              <th>上下文</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {analysis.references.map((r, i) => (
              <tr key={i} className={r.targetDefined ? '' : 'row-missing'}>
                <td className="num">第{r.number}条</td>
                <td>
                  {r.pos.line}:{r.pos.column}
                </td>
                <td className="ellipsis">{r.line}</td>
                <td>{r.targetDefined ? '✅ 已定义' : '❌ 缺失'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {missingNumbers.size > 0 && (
          <p className="muted small">
            缺失的编号：{[...missingNumbers].sort((a, b) => a - b).map((n) => `第${n}条`).join('、')}
          </p>
        )}
      </details>
    </section>
  );
}
