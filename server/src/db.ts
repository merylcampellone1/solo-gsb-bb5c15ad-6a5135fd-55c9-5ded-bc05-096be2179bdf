// SQLite 持久化。better-sqlite3 的 transaction 提供原子性：
// 提交改号（写历史 + 更新正文）在同一事务内完成，异常即整体回滚。
//
// 改号预览凭证：documents.revision 是正文的单调修订号，保存原文 / 改号提交 /
// 裁撤提交 / 撤销都会 +1（即便正文恢复成相同文本也不回退）。预览凭证存于
// renumber_previews，绑定签发时的 revision 与规范化映射；确认时在同一事务内
// 核对凭证（存在、未消费、revision 一致、映射一致）后再写正文与撤销历史，
// 并把凭证标记为已消费——同一预览并发确认至多成功一次。

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

let db: Database.Database | null = null;

export function initDB(filename: string): Database.Database {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 老库平滑升级：documents 已存在但缺少 revision 列时补上（既有文档从 1 起计）。
  const tableExists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'documents'`)
    .get();
  if (tableExists) {
    const docCols = db.prepare(`PRAGMA table_info(documents)`).all() as { name: string }[];
    if (!docCols.some((c) => c.name === 'revision')) {
      db.exec(`ALTER TABLE documents ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT NOT NULL DEFAULT '未命名合同',
      content    TEXT NOT NULL,
      revision   INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS renumber_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      before_text TEXT NOT NULL,
      after_text  TEXT NOT NULL,
      -- 操作快照 JSON：改号 {op:'renumber', mapping:[...]} 或
      -- 裁撤 {op:'remove', deletes:[...], replacements:[...]}；撤销据此恢复。
      mapping     TEXT NOT NULL,
      change_count INTEGER NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_history_doc
      ON renumber_history(document_id, id);

    -- 改号预览凭证：一次性，绑定签发时的正文修订号与本次映射。
    CREATE TABLE IF NOT EXISTS renumber_previews (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      token        TEXT NOT NULL UNIQUE,
      revision     INTEGER NOT NULL,
      mapping_json TEXT NOT NULL,
      new_text     TEXT NOT NULL,
      change_count INTEGER NOT NULL,
      consumed     INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_preview_doc
      ON renumber_previews(document_id, id);
  `);
  return db;
}

export function getDB(): Database.Database {
  if (!db) throw new Error('数据库尚未初始化');
  return db;
}

export interface DocRow {
  id: number;
  title: string;
  content: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface HistoryRow {
  id: number;
  document_id: number;
  before_text: string;
  after_text: string;
  mapping: string;
  change_count: number;
  created_at: string;
}

export interface PreviewRow {
  id: number;
  document_id: number;
  token: string;
  revision: number;
  mapping_json: string;
  new_text: string;
  change_count: number;
  consumed: number;
  created_at: string;
}

/** 凭证核对失败原因；调用方据此映射为 409 错误码与提示。 */
export type PreviewRejectCode =
  | 'PREVIEW_NOT_FOUND'
  | 'PREVIEW_CONSUMED'
  | 'PREVIEW_REVISION_STALE'
  | 'PREVIEW_MAPPING_MISMATCH';

export class PreviewRejectedError extends Error {
  constructor(readonly code: PreviewRejectCode, message: string) {
    super(message);
    this.name = 'PreviewRejectedError';
  }
}

/** 事务内重建计划的最小契约（由 renumber 引擎注入，避免 db 层反向依赖）。 */
export interface PreviewPlanner {
  (
    content: string,
    mappingJson: string,
  ):
    | { ok: true; newText: string; changeCount: number; changes: unknown; entries: unknown }
    | { ok: false };
}

const stmts = {
  insertDoc: () =>
    getDB().prepare(
      `INSERT INTO documents (title, content) VALUES (?, ?)`,
    ) as Database.Statement<[string, string]>,
  getDoc: () =>
    getDB().prepare(`SELECT * FROM documents WHERE id = ?`) as Database.Statement<[number]>,
  updateDoc: () =>
    getDB().prepare(
      `UPDATE documents SET title = ?, content = ?, updated_at = datetime('now') WHERE id = ?`,
    ) as Database.Statement<[string, string, number]>,
  bumpRevision: () =>
    getDB().prepare(
      `UPDATE documents SET revision = revision + 1, updated_at = datetime('now') WHERE id = ?`,
    ) as Database.Statement<[number]>,
  listDocs: () =>
    getDB().prepare(
      `SELECT id, title, revision, created_at, updated_at FROM documents ORDER BY id DESC LIMIT 20`,
    ),
  insertHistory: () =>
    getDB().prepare(
      `INSERT INTO renumber_history (document_id, before_text, after_text, mapping, change_count)
       VALUES (?, ?, ?, ?, ?)`,
    ) as Database.Statement<[number, string, string, string, number]>,
  lastHistory: () =>
    getDB().prepare(
      `SELECT * FROM renumber_history WHERE document_id = ? ORDER BY id DESC LIMIT 1`,
    ) as Database.Statement<[number]>,
  deleteHistory: () =>
    getDB().prepare(`DELETE FROM renumber_history WHERE id = ?`) as Database.Statement<[number]>,
  activePreviewByToken: () =>
    getDB().prepare(
      `SELECT * FROM renumber_previews WHERE document_id = ? AND token = ?`,
    ) as Database.Statement<[number, string]>,
  invalidatePreviews: () =>
    getDB().prepare(
      `DELETE FROM renumber_previews WHERE document_id = ? AND consumed = 0`,
    ) as Database.Statement<[number]>,
  insertPreview: () =>
    getDB().prepare(
      `INSERT INTO renumber_previews
         (document_id, token, revision, mapping_json, new_text, change_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ) as Database.Statement<[number, string, number, string, string, number]>,
  consumePreview: () =>
    getDB().prepare(
      `UPDATE renumber_previews SET consumed = 1 WHERE id = ? AND consumed = 0`,
    ) as Database.Statement<[number]>,
};

export function createDocument(title: string, content: string): DocRow {
  const info = stmts.insertDoc().run(title, content);
  return stmts.getDoc().get(Number(info.lastInsertRowid)) as DocRow;
}

export function getDocument(id: number): DocRow | undefined {
  return stmts.getDoc().get(id) as DocRow | undefined;
}

export function updateDocument(id: number, title: string, content: string): DocRow | undefined {
  const tx = getDB().transaction(() => {
    stmts.updateDoc().run(title, content, id);
    // 保存原文即推进修订号；旧凭证保留在表中但因 revision 不符而失效（重新确认时
    // 得到明确的“预览已过期”提示），不做物理删除。
    stmts.bumpRevision().run(id);
    getDB()
      .prepare(`DELETE FROM renumber_history WHERE document_id = ?`)
      .run(id);
  });
  tx();
  return getDocument(id);
}

export function listDocuments() {
  return stmts.listDocs().all();
}

/**
 * 原子提交（改号兼容路径或裁撤共用同一入口）：追加撤销历史 + 更新正文 + 推进修订号，
 * 任一失败整体回滚。未消费的预览凭证不物理删除，随修订号推进而在确认时被判为过期。
 * snapshotJson 为操作快照，撤销后原样返回给前端。
 */
export function commitRenumber(
  docId: number,
  before: string,
  after: string,
  snapshotJson: string,
  changeCount: number,
): void {
  const tx = getDB().transaction(() => {
    stmts.insertHistory().run(docId, before, after, snapshotJson, changeCount);
    getDB()
      .prepare(
        `UPDATE documents SET content = ?, revision = revision + 1, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(after, docId);
    // 不删除旧凭证行：revision 已前进，重新确认时会得到“预览已过期”的明确拒绝。
  });
  tx();
}

/**
 * 签发改号预览凭证：绑定当前已保存正文的修订号与本次规范化映射。
 * 同一文档旧的未消费凭证立即失效（“用户修改映射后旧预览立即失效”由
 * 工作台丢弃旧凭证 + 此处只保留最新凭证共同保证）。
 */
export function issueRenumberPreview(args: {
  documentId: number;
  revision: number;
  mappingJson: string;
  newText: string;
  changeCount: number;
}): { token: string } {
  const token = randomUUID();
  const tx = getDB().transaction(() => {
    stmts.invalidatePreviews().run(args.documentId);
    stmts
      .insertPreview()
      .run(
        args.documentId,
        token,
        args.revision,
        args.mappingJson,
        args.newText,
        args.changeCount,
      );
  });
  tx();
  return { token };
}

/**
 * 凭凭证确认改号：核对（凭证存在 / 未消费 / 修订号一致 / 映射一致）与
 * “写正文 + 写撤销历史 + 标记凭证已消费 + 推进修订号”在同一事务内完成，
 * 任一核对不过则抛 PreviewRejectedError，两个写入均不发生。
 *
 * better-sqlite3 的事务在 Node 侧串行执行，且“标记已消费”是带
 * `consumed = 0` 条件的条件更新，故同一凭证并发确认至多成功一次。
 *
 * @param expectedMappingJson 非空时（请求体带了 mapping）额外要求与凭证映射一致；
 *                            纯凭证确认时传 null，以凭证绑定的映射为准。
 * @param planner 事务内依据“当前正文 + 凭证映射”重建计划，作为权威结果落库，
 *                不直接信任预览时缓存的 new_text。
 */
export function commitRenumberWithPreview(args: {
  documentId: number;
  token: string;
  expectedMappingJson: string | null;
  planner: PreviewPlanner;
}): { after: string; changeCount: number; changes: unknown; mapping: { from: number; to: number }[] } {
  const tx = getDB().transaction(() => {
    const row = stmts.activePreviewByToken().get(args.documentId, args.token) as
      | PreviewRow
      | undefined;
    if (!row) {
      throw new PreviewRejectedError(
        'PREVIEW_NOT_FOUND',
        '预览凭证不存在或已失效，请重新生成预览。',
      );
    }
    const doc = stmts.getDoc().get(args.documentId) as DocRow;
    if (doc.revision !== row.revision) {
      throw new PreviewRejectedError(
        'PREVIEW_REVISION_STALE',
        '正文在预览后发生过变化（保存原文 / 改号 / 裁撤 / 撤销），预览已过期，请重新生成预览。',
      );
    }
    if (row.consumed) {
      throw new PreviewRejectedError(
        'PREVIEW_CONSUMED',
        '该预览已确认过，同一预览不能重复提交，请重新生成预览。',
      );
    }
    if (args.expectedMappingJson !== null && args.expectedMappingJson !== row.mapping_json) {
      throw new PreviewRejectedError(
        'PREVIEW_MAPPING_MISMATCH',
        '提交的映射与预览绑定的映射不一致，请重新生成预览。',
      );
    }

    const entries = JSON.parse(row.mapping_json) as { from: number; to: number }[];
    const planned = args.planner(doc.content, row.mapping_json);
    if (!planned.ok) {
      // revision 未变、映射即预览时通过校验的映射，正常不会走到；属于防御性拒绝。
      throw new PreviewRejectedError(
        'PREVIEW_REVISION_STALE',
        '预览的改号计划已无法应用于当前正文，请重新生成预览。',
      );
    }
    if (planned.newText !== row.new_text) {
      throw new PreviewRejectedError(
        'PREVIEW_REVISION_STALE',
        '预览结果与当前正文不再匹配，请重新生成预览。',
      );
    }

    // 条件更新抢占凭证：并发确认时只有一个事务能把 consumed 由 0 改为 1。
    const consumed = stmts.consumePreview().run(row.id);
    if (consumed.changes !== 1) {
      throw new PreviewRejectedError(
        'PREVIEW_CONSUMED',
        '该预览已被并发确认，请重新生成预览。',
      );
    }

    stmts.insertHistory().run(
      args.documentId,
      doc.content,
      planned.newText,
      JSON.stringify({ op: 'renumber', mapping: entries }),
      planned.changeCount,
    );
    getDB()
      .prepare(
        `UPDATE documents SET content = ?, revision = revision + 1, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(planned.newText, args.documentId);
    // 本次确认只消费当前凭证；其余未消费凭证保留，因 revision 已前进而报“已过期”。
    return {
      after: planned.newText,
      changeCount: planned.changeCount,
      changes: planned.changes,
      mapping: entries,
    };
  });
  return tx() as {
    after: string;
    changeCount: number;
    changes: unknown;
    mapping: { from: number; to: number }[];
  };
}

export function getLastHistory(docId: number): HistoryRow | undefined {
  return stmts.lastHistory().get(docId) as HistoryRow | undefined;
}

/**
 * 撤销最近一次改号：恢复历史中的正文并弹出栈顶记录，原子完成。
 * 撤销同样推进修订号——即便恢复出的文本与更早版本逐字相同，旧预览凭证也不复活。
 */
export function undoLastRenumber(docId: number): HistoryRow | null {
  const last = getLastHistory(docId);
  if (!last) return null;
  const tx = getDB().transaction((h: HistoryRow) => {
    getDB()
      .prepare(
        `UPDATE documents SET content = ?, revision = revision + 1, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(h.before_text, h.document_id);
    stmts.deleteHistory().run(h.id);
    // 不删除旧凭证行：修订号已前进，重新确认时明确提示预览过期（文本相同也不复活）。
  });
  tx(last);
  return last;
}
