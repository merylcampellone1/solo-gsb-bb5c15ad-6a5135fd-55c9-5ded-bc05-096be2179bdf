import { useState } from 'react';
import { api } from './api';
import type {
  AnalyzeDTO,
  CommitResult,
  ConflictError,
  DocumentDTO,
  MappingEntry,
  PreviewResult,
  RemovalCommitResult,
  RemovalImpact,
  RemovalPreviewResult,
  RemovalReplacement,
  UndoResult,
  VersionDiff,
} from './types';
import { SAMPLE_CONTRACT, CLEAN_SAMPLE_CONTRACT, DIFF_SAMPLE_DRAFT } from './sample';
import AnalysisPanel from './components/AnalysisPanel';
import MappingEditor, { type MappingRow } from './components/MappingEditor';
import PreviewPanel from './components/PreviewPanel';
import RemovalPanel from './components/RemovalPanel';
import RemovalPreview from './components/RemovalPreview';
import ExcerptPanel from './components/ExcerptPanel';
import VersionDiffPanel from './components/VersionDiffPanel';
import Conflicts from './components/Conflicts';
import HighlightedText from './components/HighlightedText';

interface ClientError {
  code: string;
  message: string;
  conflicts: ConflictError[];
}

let rowSeq = 1;
const emptyRows = (): MappingRow[] => [{ id: rowSeq++, from: '', to: '' }];

export default function App() {
  const [draft, setDraft] = useState('');
  const [doc, setDoc] = useState<DocumentDTO | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeDTO | null>(null);
  const [rows, setRows] = useState<MappingRow[]>(emptyRows());
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [committed, setCommitted] = useState<CommitResult | null>(null);
  const [lastUndo, setLastUndo] = useState<UndoResult | null>(null);
  const [conflicts, setConflicts] = useState<ConflictError[]>([]);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);

  // 条款裁撤状态
  const [removeSelected, setRemoveSelected] = useState<Set<number>>(new Set());
  const [removeImpact, setRemoveImpact] = useState<RemovalImpact | null>(null);
  const [removeReplacements, setRemoveReplacements] = useState<RemovalReplacement[]>([]);
  const [removePreview, setRemovePreview] = useState<RemovalPreviewResult | null>(null);
  const [removeCommitted, setRemoveCommitted] = useState<RemovalCommitResult | null>(null);

  // 版本对照状态（只读）
  const [diffDraft, setDiffDraft] = useState('');
  const [versionDiff, setVersionDiff] = useState<VersionDiff | null>(null);

  // 条款摘录面板在正文变化（重新解析 / 编辑保存 / 提交 / 撤销）后整组重置
  const [excerptSeq, setExcerptSeq] = useState(0);

  const toMapping = (): MappingEntry[] =>
    rows
      .map((r) => ({ from: Number(r.from), to: Number(r.to) }))
      .filter((m) => Number.isInteger(m.from) && Number.isInteger(m.to));

  const resetWorkspace = (d: DocumentDTO, a: AnalyzeDTO) => {
    setDoc(d);
    setAnalysis(a);
    setRows(emptyRows());
    setPreview(null);
    setCommitted(null);
    setLastUndo(null);
    setConflicts([]);
    setEditing(false);
    resetRemoval();
    setDiffDraft('');
    setVersionDiff(null);
    setExcerptSeq((n) => n + 1);
  };

  const resetRemoval = () => {
    setRemoveSelected(new Set());
    setRemoveImpact(null);
    setRemoveReplacements([]);
    setRemovePreview(null);
    setRemoveCommitted(null);
  };

  const parse = async () => {
    if (!draft.trim()) {
      setNotice('请先粘贴合同文本。');
      return;
    }
    setLoading(true);
    setConflicts([]);
    setNotice('');
    try {
      const { document, analysis } = await api.createDocument('未命名合同', draft);
      resetWorkspace(document, analysis);
      setNotice('解析完成，已建立工作台文档。');
    } catch (e) {
      const err = e as ClientError;
      setConflicts(err.conflicts.length ? err.conflicts : []);
      setNotice(err.message);
    } finally {
      setLoading(false);
    }
  };

  const changeRows = (next: MappingRow[]) => {
    setRows(next);
    // 映射一旦改动，旧预览即失效
    setPreview(null);
    setCommitted(null);
    setConflicts([]);
  };

  const doPreview = async () => {
    if (!doc) return;
    setLoading(true);
    setConflicts([]);
    setNotice('');
    try {
      const result = await api.preview(doc.id, toMapping());
      setPreview(result);
      setCommitted(null);
    } catch (e) {
      const err = e as ClientError;
      setPreview(null);
      setConflicts(
        err.conflicts.length
          ? err.conflicts
          : [{ code: err.code, message: err.message }],
      );
    } finally {
      setLoading(false);
    }
  };

  const doCommit = async () => {
    if (!doc) return;
    // 工作台确认改号必须使用预览凭证：修改映射后旧预览已被清空，
    // 此处兜底拦截，避免发出不带凭证的请求。
    if (!preview) {
      setNotice('请先生成变更预览，再确认提交。');
      return;
    }
    const ticket = preview.ticket;
    setLoading(true);
    setConflicts([]);
    setNotice('');
    try {
      const result = await api.commit(doc.id, toMapping(), ticket);
      setDoc(result.document);
      setAnalysis(result.analysis);
      setCommitted(result);
      setPreview(null);
      setRows(emptyRows());
      setLastUndo(null);
      resetRemoval();
      setVersionDiff(null);
      setExcerptSeq((n) => n + 1);
      setNotice(`已原子提交：共更新 ${result.changeCount} 处“第X条”。可撤销本次操作。`);
    } catch (e) {
      const err = e as ClientError;
      // 凭证过期 / 映射不符 / 已确认过：旧预览立即失效，需重新预览。
      const ticketCodes = ['PREVIEW_NOT_FOUND', 'PREVIEW_EXPIRED', 'PREVIEW_MAPPING_MISMATCH'];
      if (ticketCodes.includes(err.code)) {
        setPreview(null);
        setNotice(err.message);
        setConflicts([]);
      } else {
        setConflicts(
          err.conflicts.length
            ? err.conflicts
            : [{ code: err.code, message: err.message }],
        );
      }
    } finally {
      setLoading(false);
    }
  };

  // ---------- 条款裁撤 ----------

  const changeRemoveSelection = (next: Set<number>) => {
    setRemoveSelected(next);
    setRemoveImpact(null);
    setRemovePreview(null);
    setRemoveCommitted(null);
  };

  const changeRemoveReplacements = (rows2: RemovalReplacement[]) => {
    setRemoveReplacements(rows2);
    setRemovePreview(null);
    setRemoveCommitted(null);
  };

  const doRemovalImpact = async () => {
    if (!doc || removeSelected.size === 0) return;
    setLoading(true);
    setConflicts([]);
    setNotice('');
    try {
      const deletes = [...removeSelected].sort((a, b) => a - b);
      const { impact } = await api.removalImpact(doc.id, deletes, removeReplacements);
      setRemoveImpact(impact);
      // 自动为需要映射的待删编号保留已有选择，其余清空，交由用户逐组选择
      const needed = new Set(impact.directReferences.map((r) => r.number));
      setRemoveReplacements(
        removeReplacements.filter(
          (r) => needed.has(r.from) && removeSelected.has(r.from),
        ),
      );
    } catch (e) {
      const err = e as ClientError;
      setConflicts(
        err.conflicts.length
          ? err.conflicts
          : [{ code: err.code, message: err.message }],
      );
    } finally {
      setLoading(false);
    }
  };

  const doRemovalPreview = async () => {
    if (!doc || removeSelected.size === 0) return;
    setLoading(true);
    setConflicts([]);
    setNotice('');
    try {
      const deletes = [...removeSelected].sort((a, b) => a - b);
      const result = await api.removalPreview(doc.id, deletes, removeReplacements);
      setRemovePreview(result);
      setRemoveCommitted(null);
    } catch (e) {
      const err = e as ClientError;
      setRemovePreview(null);
      setConflicts(
        err.conflicts.length
          ? err.conflicts
          : [{ code: err.code, message: err.message }],
      );
    } finally {
      setLoading(false);
    }
  };

  const doRemovalCommit = async () => {
    if (!doc || removeSelected.size === 0) return;
    setLoading(true);
    setConflicts([]);
    setNotice('');
    try {
      const deletes = [...removeSelected].sort((a, b) => a - b);
      const result = await api.removalCommit(doc.id, deletes, removeReplacements);
      setDoc(result.document);
      setAnalysis(result.analysis);
      setRemoveCommitted(result);
      setRemovePreview(null);
      setRemoveImpact(null);
      setRemoveSelected(new Set());
      setRemoveReplacements([]);
      setRows(emptyRows());
      setPreview(null);
      setCommitted(null);
      setLastUndo(null);
      setVersionDiff(null);
      setExcerptSeq((n) => n + 1);
      setNotice(
        `已原子裁撤 ${result.deleteCount} 个条款区块，改写 ${result.changeCount} 处引用。可撤销本次操作。`,
      );
    } catch (e) {
      const err = e as ClientError;
      setConflicts(
        err.conflicts.length
          ? err.conflicts
          : [{ code: err.code, message: err.message }],
      );
    } finally {
      setLoading(false);
    }
  };

  const doUndo = async () => {
    if (!doc) return;
    setLoading(true);
    setConflicts([]);
    setNotice('');
    try {
      const result = await api.undo(doc.id);
      setDoc(result.document);
      setAnalysis(result.analysis);
      setLastUndo(result);
      setCommitted(null);
      setPreview(null);
      setRows(emptyRows());
      resetRemoval();
      setVersionDiff(null);
      setExcerptSeq((n) => n + 1);
      const opText = result.undone.op === 'remove' ? '条款裁撤' : '改号';
      setNotice(
        `已撤销最近一次${opText}（${result.undone.changeCount} 处引用变更，恢复到操作前文本）。`,
      );
    } catch (e) {
      const err = e as ClientError;
      setNotice(err.message);
    } finally {
      setLoading(false);
    }
  };

  const saveEdit = async () => {
    if (!doc) return;
    setLoading(true);
    try {
      const { document, analysis } = await api.updateDocument(doc.id, doc.title, draft);
      resetWorkspace(document, analysis);
      setNotice('原文已更新（此前撤销记录已清空）。');
    } catch (e) {
      setNotice((e as ClientError).message);
    } finally {
      setLoading(false);
    }
  };

  // ---------- 版本对照（只读） ----------

  const changeDiffDraft = (text: string) => {
    setDiffDraft(text);
    // 新稿改动后旧结果失效
    setVersionDiff(null);
  };

  const doVersionDiff = async () => {
    if (!doc) return;
    if (!diffDraft.trim()) {
      setNotice('请先粘贴用于对照的新稿文本。');
      return;
    }
    setLoading(true);
    setConflicts([]);
    setNotice('');
    try {
      const { diff } = await api.versionDiff(doc.id, diffDraft);
      setVersionDiff(diff);
      setNotice('版本对照完成：结果只读，未改动当前文档与撤销历史。');
    } catch (e) {
      const err = e as ClientError;
      setVersionDiff(null);
      setNotice(err.message);
    } finally {
      setLoading(false);
    }
  };

  const changedTargets = committed
    ? new Set(committed.changes.map((c) => c.toNumber))
    : null;

  return (
    <div className="app">
      <header>
        <h1>合同条款重编号工作台</h1>
        <p className="subtitle">
          解析“第X条”定义与引用 · 版本对照（新增/删除/修改/仅改号） · 条款裁撤与引用图影响分析 · 条款摘录（递归收齐引用） · 批量映射改号 · 逐处预览 · 原子提交 · 可撤销 · 可导出
        </p>
      </header>

      {notice && <div className="notice">{notice}</div>}
      <Conflicts conflicts={conflicts} />

      {/* 步骤一：粘贴文本 */}
      <section className="card">
        <h3>
          1. 粘贴合同纯文本
          {doc && !editing && (
            <button
              type="button"
              className="btn btn-link"
              onClick={() => {
                setDraft(doc.content);
                setEditing(true);
              }}
            >
              编辑原文
            </button>
          )}
        </h3>
        {!doc || editing ? (
          <>
            <textarea
              className="contract-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={'在此粘贴合同文本……\n系统将识别行首的“第X条”为条款定义，其余出现为引用。'}
              rows={14}
            />
            <div className="row-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setDraft(SAMPLE_CONTRACT)}
              >
                载入示例（含重复编号 / 缺失引用 / 第1条与第10条）
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setDraft(CLEAN_SAMPLE_CONTRACT)}
              >
                载入无冲突示例（含引用链与循环引用，适合体验条款裁撤）
              </button>
              <div className="spacer" />
              {editing && (
                <button type="button" className="btn" onClick={() => setEditing(false)}>
                  取消
                </button>
              )}
              <button type="button" className="btn btn-primary" onClick={parse} disabled={loading}>
                {loading ? '解析中…' : '解析并建立工作台'}
              </button>
              {editing && (
                <button type="button" className="btn" onClick={saveEdit} disabled={loading}>
                  保存原文
                </button>
              )}
            </div>
          </>
        ) : (
          <details>
            <summary>查看当前原文</summary>
            <pre className="contract-view">{doc.content}</pre>
          </details>
        )}
      </section>

      {analysis && !editing && (
        <>
          <div className="step">2. 检查引用关系</div>
          <AnalysisPanel analysis={analysis} />

          <div className="step">3. 版本对照（可选，只读）：粘贴新稿 → 按条款对照新增 / 删除 / 修改 / 仅改号</div>
          <section className="card">
            <h3>版本对照：以当前已保存合同为旧稿</h3>
            <p className="muted small">
              粘贴修改后的合同新稿，系统按现有标题边界拆分两版条款：先去掉标题编号并规范空白，
              以内容唯一匹配跨编号条款，再对剩余的唯一同号条款配对；重复内容形成多候选时列为
              <strong>待确认</strong>，不擅自归类。对照过程<strong>只读</strong>，不会修改文档或撤销历史。
            </p>
            <textarea
              className="contract-input"
              value={diffDraft}
              onChange={(e) => changeDiffDraft(e.target.value)}
              placeholder={'在此粘贴新稿合同文本……\n建议先在第 1 步“编辑原文”保存旧稿，再把修订版粘到此处。'}
              rows={10}
            />
            <div className="row-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => changeDiffDraft(DIFF_SAMPLE_DRAFT)}
              >
                载入对照示例新稿（与“无冲突示例”旧稿配套，含仅改号 / 修改 / 新增 / 删除）
              </button>
              <div className="spacer" />
              <button
                type="button"
                className="btn btn-primary"
                onClick={doVersionDiff}
                disabled={loading || !diffDraft.trim()}
              >
                {loading ? '对照中…' : '生成版本对照'}
              </button>
            </div>
          </section>

          {versionDiff && <VersionDiffPanel diff={versionDiff} />}

          <div className="step">4. 条款裁撤（可选）：勾选条款 → 分析影响 → 替代引用 → 预览确认</div>
          <RemovalPanel
            analysis={analysis}
            selected={removeSelected}
            onSelectChange={changeRemoveSelection}
            impact={removeImpact}
            loading={loading}
            onAnalyze={doRemovalImpact}
            replacements={removeReplacements}
            onReplacementsChange={changeRemoveReplacements}
            onPreview={doRemovalPreview}
            hasPreview={!!removePreview}
          />

          {removePreview && (
            <>
              <RemovalPreview preview={removePreview} />
              <section className="card final-bar">
                <span className="muted small">
                  后端会在提交时再次校验；未处理引用、替代目标在删除集合中、重复/缺失定义都会整体拒绝。
                </span>
                <div className="spacer" />
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={doRemovalCommit}
                  disabled={loading}
                >
                  确认裁撤并原子提交（{removePreview.deleteCount} 个条款）
                </button>
              </section>
            </>
          )}

          {removeCommitted && (
            <section className="card">
              <h3>✅ 裁撤已提交</h3>
              <p className="muted">
                删除第 {removeCommitted.deletes.map((n) => n).join('、')} 条共{' '}
                {removeCommitted.deleteCount} 个区块，改写引用{' '}
                {removeCommitted.changeCount} 处。
              </p>
              <details open>
                <summary>处理后的全文</summary>
                <pre className="contract-view">{removeCommitted.document.content}</pre>
              </details>
            </section>
          )}

          <div className="step">5. 条款摘录（可选，只读）：勾选起点 → 沿引用递归收齐 → 复制纯文本</div>
          <ExcerptPanel key={`excerpt-${doc!.id}-${excerptSeq}`} docId={doc!.id} analysis={analysis} />

          <div className="step">6. 改号映射（可选）</div>
          <MappingEditor
            analysis={analysis}
            rows={rows}
            onChange={changeRows}
            onPreview={doPreview}
            onCommit={doCommit}
            loading={loading}
            hasPreview={!!preview}
          />

          {preview && <PreviewPanel preview={preview} />}

          {committed && (
            <section className="card">
              <h3>✅ 已提交结果</h3>
              <p className="muted">
                本次更新 {committed.changeCount} 处，映射：
                {committed.mapping.map((m) => `${m.from}→${m.to}`).join('、')}
              </p>
              <details open>
                <summary>处理后的全文（高亮本次变更）</summary>
                {changedTargets && (
                  <HighlightedText text={committed.document.content} targets={changedTargets} />
                )}
              </details>
            </section>
          )}

          <div className="step">7. 撤销 / 导出</div>
          <section className="card final-bar">
            <button type="button" className="btn" onClick={doUndo} disabled={loading}>
              ↩ 撤销最近一次操作（改号 / 裁撤）
            </button>
            <a className="btn btn-primary" href={doc ? api.exportUrl(doc.id) : '#'}>
              ⬇ 导出处理后的文本（.txt）
            </a>
            {lastUndo && (
              <span className="muted small">
                上次撤销：{lastUndo.undone.op === 'remove' ? '条款裁撤' : '改号'}（
                {lastUndo.undone.changeCount} 处引用变更）
              </span>
            )}
          </section>
        </>
      )}

      <footer className="muted small">
        编号支持阿拉伯数字与中文数字（第一条 ↔ 第1条风格各自保留）；冲突拒绝写入并给出
        行/列位置。
      </footer>
    </div>
  );
}
