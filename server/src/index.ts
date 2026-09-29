import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  initDB,
  createDocument,
  getDocument,
  updateDocument,
  listDocuments,
  commitRenumber,
  undoLastRenumber,
  createRenumberPreview,
  commitRenumberWithTicket,
  PreviewTicketError,
} from './db';
import { analyzeText, toAnalyzeDTO } from './parser';
import { buildPlan, normalizeMapping, type ConflictError, type RawRow } from './renumber';
import {
  analyzeRemoval,
  buildRemovalPlan,
  normalizeRemovalRequest,
  type RemovalConflict,
  type RemovalReplacement,
} from './removal';
import { diffVersions } from './diff';
import { buildExcerpt, normalizeExcerptRequest } from './excerpt';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
// 默认放在 server/data 下；容器通过 ENV DB_PATH=/data/contract.db 覆盖到持久化卷。
const DB_PATH = process.env.DB_PATH ?? path.join(__dirname, '..', 'data', 'contract.db');

initDB(DB_PATH);

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ---------- helpers ----------

function fail(res: express.Response, status: number, code: string, message: string, extra?: object) {
  res.status(status).json({ error: { code, message, ...extra } });
}

function analysisOf(content: string) {
  return toAnalyzeDTO(content, analyzeText(content));
}

/** 校验并规范化映射，冲突时以 409 返回（不做任何写入）。 */
function planOrConflict(res: express.Response, content: string, rawMapping: unknown) {
  const { entries, errors } = normalizeMapping((rawMapping as RawRow[]) ?? []);
  if (errors.length > 0) {
    fail(res, 409, 'MAPPING_REJECTED', '映射未通过校验，已拒绝写入。', { conflicts: errors });
    return null;
  }
  const plan = buildPlan(content, entries);
  if (!plan.ok) {
    const conflicts: ConflictError[] = plan.conflicts ?? [];
    fail(res, 409, 'RENUMBER_CONFLICT', '存在编号冲突，已拒绝写入。', { conflicts });
    return null;
  }
  return { entries, plan };
}

/**
 * 解析并校验裁撤请求；输入形态错误以 409 返回。
 * 返回的 plan 可能仍含语义冲突（未处理引用等），由调用方再次判定。
 */
function removalOrConflict(
  res: express.Response,
  content: string,
  body: unknown,
): { deletes: number[]; replacements: RemovalReplacement[]; plan: ReturnType<typeof buildRemovalPlan> } | null {
  const b = (body ?? {}) as { deletes?: unknown; replacements?: unknown };
  const { deletes, replacements, errors } = normalizeRemovalRequest(b);
  if (errors.length > 0) {
    fail(res, 409, 'REMOVAL_REJECTED', '裁撤请求未通过校验，已拒绝写入。', { conflicts: errors });
    return null;
  }
  const plan = buildRemovalPlan(content, deletes, replacements);
  if (!plan.ok) {
    const conflicts: RemovalConflict[] = plan.conflicts ?? [];
    fail(res, 409, 'REMOVAL_CONFLICT', '条款裁撤存在未处理问题，已拒绝写入。', { conflicts });
    return null;
  }
  return { deletes, replacements, plan };
}

const requireDoc = (res: express.Response, id: number) => {
  const doc = getDocument(id);
  if (!doc) {
    fail(res, 404, 'NOT_FOUND', `文档 ${id} 不存在。`);
    return null;
  }
  return doc;
};

// ---------- API ----------

// 无状态解析：不写库，粘贴即可检查缺失引用 / 重复编号。
app.post('/api/analyze', (req, res) => {
  const content = typeof req.body?.content === 'string' ? req.body.content : null;
  if (content === null) return fail(res, 400, 'BAD_REQUEST', '缺少 content（纯文本）。');
  res.json({ analysis: analysisOf(content) });
});

// 版本对照（只读）：入参直接给旧稿/新稿，不写库、不改文档、不产生撤销历史。
app.post('/api/diff', (req, res) => {
  const oldContent = typeof req.body?.oldContent === 'string' ? req.body.oldContent : null;
  const newContent = typeof req.body?.newContent === 'string' ? req.body.newContent : null;
  if (oldContent === null || newContent === null) {
    return fail(res, 400, 'BAD_REQUEST', '缺少 oldContent / newContent（纯文本）。');
  }
  res.json({ diff: diffVersions(oldContent, newContent) });
});

app.get('/api/documents', (_req, res) => {
  res.json({ documents: listDocuments() });
});

app.post('/api/documents', (req, res) => {
  const content = typeof req.body?.content === 'string' ? req.body.content : null;
  const title = typeof req.body?.title === 'string' && req.body.title.trim()
    ? req.body.title.trim()
    : '未命名合同';
  if (content === null) return fail(res, 400, 'BAD_REQUEST', '缺少 content（纯文本）。');
  const doc = createDocument(title, content);
  res.status(201).json({ document: doc, analysis: analysisOf(doc.content) });
});

app.get('/api/documents/:id', (req, res) => {
  const doc = requireDoc(res, Number(req.params.id));
  if (!doc) return;
  res.json({ document: doc, analysis: analysisOf(doc.content) });
});

// 手工修改原文：内容更新，撤销栈清空（历史已不连续）。
app.put('/api/documents/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = requireDoc(res, id);
  if (!existing) return;
  const content = typeof req.body?.content === 'string' ? req.body.content : existing.content;
  const title =
    typeof req.body?.title === 'string' && req.body.title.trim()
      ? req.body.title.trim()
      : existing.title;
  const doc = updateDocument(id, title, content)!;
  res.json({ document: doc, analysis: analysisOf(doc.content) });
});

// 逐处变更预览（只读）。返回一次性确认凭证 ticket，绑定当前已保存正文的
// 单调修订号 revision 与本次规范化映射；正文被保存/提交/裁撤/撤销推进，
// 或用户修改映射后，旧凭证立即失效（映射不符 / revision 不符都会被拒绝）。
app.post('/api/documents/:id/renumber/preview', (req, res) => {
  const id = Number(req.params.id);
  const doc = requireDoc(res, id);
  if (!doc) return;
  const planned = planOrConflict(res, doc.content, req.body?.mapping);
  if (!planned) return;
  const changeCount = planned.plan.changes!.length;
  const ticket = createRenumberPreview(doc.id, doc.revision, planned.entries, changeCount);
  res.json({
    mapping: planned.entries,
    changeCount,
    changes: planned.plan.changes,
    previewText: planned.plan.newText,
    revision: doc.revision,
    ticket: ticket.token,
  });
});

// 确认提交。
//   - 工作台：请求体带 ticket（预览返回的一次性凭证）。服务端在同一 IMMEDIATE
//     事务内核对凭证是否存在、是否已消费、revision 是否仍为当前值、映射是否与
//     预览时一致，并按当前正文重算计划；全部通过后消费凭证、写撤销历史、更新正文。
//     凭证过期 / 映射不符 / 重复确认均以 409 拒绝（两个写入均不发生），提示重新预览。
//   - 不带 ticket 的旧请求：仍按原有校验、响应与撤销规则工作（兼容旧调用方）。
app.post('/api/documents/:id/renumber/commit', (req, res) => {
  const id = Number(req.params.id);
  const doc = requireDoc(res, id);
  if (!doc) return;

  const rawTicket = (req.body as { ticket?: unknown } | null | undefined)?.ticket;
  const hasTicket = typeof rawTicket === 'string' && rawTicket.length > 0;

  if (hasTicket) {
    // 工作台凭证路径：映射形态先做与旧路径一致的规范化校验；
    // 凭证本身的核对（revision / 映射一致性 / 一次性）全部在事务内完成。
    const { entries, errors } = normalizeMapping(
      ((req.body as { mapping?: unknown } | null)?.mapping as RawRow[]) ?? [],
    );
    if (errors.length > 0) {
      return fail(res, 409, 'PREVIEW_MAPPING_MISMATCH', '映射未通过校验，请修改映射后重新生成预览。', {
        conflicts: errors,
      });
    }
    try {
      const result = commitRenumberWithTicket(id, rawTicket as string, entries);
      return res.json({
        document: result.doc,
        mapping: result.entries,
        changeCount: result.changes.length,
        changes: result.changes,
        revision: result.revision,
        analysis: analysisOf(result.doc.content),
      });
    } catch (e) {
      if (e instanceof PreviewTicketError) {
        return fail(res, 409, e.code, e.message);
      }
      throw e;
    }
  }

  // 兼容路径：不带凭证，沿用原有校验、响应与撤销规则。
  const planned = planOrConflict(res, doc.content, req.body?.mapping);
  if (!planned) return;
  const { entries, plan } = planned;

  commitRenumber(
    id,
    doc.content,
    plan.newText!,
    JSON.stringify({ op: 'renumber', mapping: entries }),
    plan.changes!.length,
  );

  const updated = getDocument(id)!;
  res.json({
    document: updated,
    mapping: entries,
    changeCount: plan.changes!.length,
    changes: plan.changes,
    revision: updated.revision,
    analysis: analysisOf(updated.content),
  });
});

// ---------- 条款裁撤 ----------

// 影响分析（只读）：按标题边界识别区块、构建引用图，
// 返回直接引用待删条款的位置与沿引用链传递受影响的条款。
app.post('/api/documents/:id/removal/impact', (req, res) => {
  const id = Number(req.params.id);
  const doc = requireDoc(res, id);
  if (!doc) return;
  const { deletes, errors } = normalizeRemovalRequest(req.body ?? {});
  if (errors.length > 0) {
    return fail(res, 409, 'REMOVAL_REJECTED', '裁撤请求未通过校验。', { conflicts: errors });
  }
  const graph = analyzeRemoval(doc.content, deletes);
  // 回显当前替代目标，便于前端保持编辑状态
  const replacementByFrom = new Map<number, number>();
  for (const r of (req.body as { replacements?: RemovalReplacement[] }).replacements ?? []) {
    replacementByFrom.set(r.from, r.to);
  }
  if (replacementByFrom.size > 0) {
    for (const d of graph.directReferences) {
      if (replacementByFrom.has(d.number)) d.replacement = replacementByFrom.get(d.number);
    }
  }
  res.json({ deletes, impact: graph });
});

// 删除区块与逐处替换预览（只读，冲突返回 409 并附行列位置）。
app.post('/api/documents/:id/removal/preview', (req, res) => {
  const id = Number(req.params.id);
  const doc = requireDoc(res, id);
  if (!doc) return;
  const planned = removalOrConflict(res, doc.content, req.body);
  if (!planned) return;
  const { deletes, replacements, plan } = planned;
  res.json({
    deletes,
    replacements,
    deleteCount: plan.deleteCount!,
    blocks: plan.blocks,
    changes: plan.changes,
    changeCount: plan.changes!.length,
    impact: analyzeRemoval(doc.content, deletes),
    previewText: plan.newText,
  });
});

// 确认裁撤：删除区块、引用替换与撤销历史在同一 SQLite 事务原子落库。
app.post('/api/documents/:id/removal/commit', (req, res) => {
  const id = Number(req.params.id);
  const doc = requireDoc(res, id);
  if (!doc) return;
  const planned = removalOrConflict(res, doc.content, req.body);
  if (!planned) return;
  const { deletes, replacements, plan } = planned;

  commitRenumber(
    id,
    doc.content,
    plan.newText!,
    JSON.stringify({ op: 'remove', deletes, replacements }),
    plan.changes!.length,
  );

  const updated = getDocument(id)!;
  res.json({
    document: updated,
    deletes,
    replacements,
    deleteCount: plan.deleteCount!,
    blocks: plan.blocks,
    changes: plan.changes,
    changeCount: plan.changes!.length,
    analysis: analysisOf(updated.content),
  });
});

// 撤销最近一次改号（栈式，可连续撤销）。
app.post('/api/documents/:id/undo', (req, res) => {
  const id = Number(req.params.id);
  const doc = requireDoc(res, id);
  if (!doc) return;
  const undone = undoLastRenumber(id);
  if (!undone) {
    return fail(res, 409, 'NOTHING_TO_UNDO', '没有可撤销的改号记录。');
  }
  const updated = getDocument(id)!;
  const snapshot = JSON.parse(undone.mapping) as {
    op?: string;
    mapping?: unknown;
    deletes?: unknown;
    replacements?: unknown;
  };
  res.json({
    document: updated,
    undone: {
      op: snapshot.op ?? 'renumber',
      mapping: snapshot.mapping ?? snapshot,
      deletes: snapshot.deletes ?? null,
      replacements: snapshot.replacements ?? null,
      changeCount: undone.change_count,
      createdAt: undone.created_at,
    },
    analysis: analysisOf(updated.content),
  });
});

// 导出处理后的纯文本。
app.get('/api/documents/:id/export', (req, res) => {
  const id = Number(req.params.id);
  const doc = requireDoc(res, id);
  if (!doc) return;
  const filename = encodeURIComponent(`${doc.title || 'contract'}.txt`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  res.send(doc.content);
});

// 版本对照（只读）：以已保存合同为旧稿、请求体 newContent 为新稿，
// 按标题边界拆分条款后配对。不写库、不改文档、不触碰撤销历史。
app.post('/api/documents/:id/diff', (req, res) => {
  const id = Number(req.params.id);
  const doc = requireDoc(res, id);
  if (!doc) return;
  const newContent = typeof req.body?.newContent === 'string' ? req.body.newContent : null;
  if (newContent === null) {
    return fail(res, 400, 'BAD_REQUEST', '缺少 newContent（新稿纯文本）。');
  }
  res.json({ diff: diffVersions(doc.content, newContent) });
});

// 条款摘录（只读）：勾选一个或多个条款，沿正文“第X条”引用递归收齐条款，
// 按原文顺序输出可复制的纯文本。不写库、不改文档、不触碰撤销历史。
app.post('/api/documents/:id/excerpt', (req, res) => {
  const id = Number(req.params.id);
  const doc = requireDoc(res, id);
  if (!doc) return;
  const { numbers, errors } = normalizeExcerptRequest(req.body ?? {});
  if (errors.length > 0) {
    return fail(res, 409, 'EXCERPT_REJECTED', '摘录请求未通过校验。', { conflicts: errors });
  }
  const result = buildExcerpt(doc.content, numbers);
  if (!result.ok) {
    return fail(res, 409, 'EXCERPT_CONFLICT', '条款摘录存在未处理问题，已拒绝生成。', {
      conflicts: result.conflicts,
    });
  }
  res.json({ selected: numbers, excerpt: result.excerpt });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ---------- 生产环境静态资源 ----------

const clientDist = path.join(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  fail(res, 500, 'INTERNAL', err.message || '服务器内部错误');
});

app.listen(PORT, HOST, () => {
  console.log(`合同条款重编号工作台已启动: http://localhost:${PORT}`);
  console.log(`SQLite: ${DB_PATH}`);
});
