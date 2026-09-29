// SQLite 持久化。better-sqlite3 的 transaction 提供原子性：
// 提交改号（写历史 + 更新正文）在同一事务内完成，异常即整体回滚。
//
// 改号预览凭证（token）绑定“生成预览时的正文单调修订号 revision + 规范化映射”。
// 保存原文 / 提交改号 / 提交裁撤 / 撤销都会推进 revision，旧凭证立即失效；
// 即使正文后来恢复为相同文本，revision 也不会回退，旧凭证不会复活。
// 凭证消费（consumeRenumberPreview）与正文、撤销历史的写入在同一 IMMEDIATE
// 事务内完成：条件 UPDATE 保证同一凭证至多成功一次，任一核对失败整体回滚。

import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildPlan, type MappingEntry } from './renumber';

let db: Database.Database | null = null;

export function initDB(filename: string): Database.Database {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT NOT NULL DEFAULT '未命名合同',
      content    TEXT NOT NULL,
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

    -- 改号预览凭证：绑定生成时的正文修订号与规范化映射，仅可成功消费一次。
    CREATE TABLE IF NOT EXISTS renumber_previews (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      token       TEXT NOT NULL UNIQUE,
      revision    INTEGER NOT NULL,
      mapping     TEXT NOT NULL,
      change_count INTEGER NOT NULL,
      consumed_at TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_previews_doc
      ON renumber_previews(document_id, id);
  `);

  // 迁移：旧库 documents 表没有 revision 列时补齐；存量行从 1 起，
  // 之后任何写入（保存原文 / 提交 / 撤销）都会推进。
  const cols = db.prepare(`PRAGMA table_info(documents)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'revision')) {
    db.exec(
      `ALTER TABLE documents ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;`,
    );
  }

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
  mapping: string;
  change_count: number;
  consumed_at: string | null;
  created_at: string;
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
      // 手工保存原文：推进单调修订号（即便内容逐字相同也 +1，旧凭证不复活）。
      `UPDATE documents
         SET title = ?, content = ?, revision = revision + 1, updated_at = datetime('now')
       WHERE id = ?`,
    ) as Database.Statement<[string, string, number]>,
  listDocs: () =>
    getDB().prepare(
      `SELECT id, title, created_at, updated_at FROM documents ORDER BY id DESC LIMIT 20`,
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
  insertPreview: () =>
    getDB().prepare(
      `INSERT INTO renumber_previews (document_id, token, revision, mapping, change_count)
       VALUES (?, ?, ?, ?, ?)`,
    ) as Database.Statement<[number, string, number, string, number]>,
  getPreview: () =>
    getDB().prepare(
      `SELECT * FROM renumber_previews WHERE document_id = ? AND token = ?`,
    ) as Database.Statement<[number, string]>,
  // 条件消费：仅当凭证未消费时命中。changes===1 即本次抢到唯一一次确认。
  consumePreview: () =>
    getDB().prepare(
      `UPDATE renumber_previews SET consumed_at = datetime('now')
       WHERE document_id = ? AND token = ? AND consumed_at IS NULL`,
    ) as Database.Statement<[number, string]>,
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
 * 原子提交（改号或裁撤共用同一入口）：追加撤销历史 + 更新正文，
 * 任一失败整体回滚。snapshotJson 为操作快照，撤销后原样返回给前端。
 * revision 单调递增——正文后来恢复相同文本也不恢复旧凭证。
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
        `UPDATE documents
           SET content = ?, revision = revision + 1, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(after, docId);
  });
  tx();
}

export function getLastHistory(docId: number): HistoryRow | undefined {
  return stmts.lastHistory().get(docId) as HistoryRow | undefined;
}

/** 撤销最近一次操作：恢复历史中的正文并弹出栈顶记录，原子完成；revision 同样 +1。 */
export function undoLastRenumber(docId: number): HistoryRow | null {
  const last = getLastHistory(docId);
  if (!last) return null;
  const tx = getDB().transaction((h: HistoryRow) => {
    getDB()
      .prepare(
        `UPDATE documents
           SET content = ?, revision = revision + 1, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(h.before_text, h.document_id);
    stmts.deleteHistory().run(h.id);
  });
  tx(last);
  return last;
}

// ---------- 改号预览凭证 ----------

/** 规范化映射：按旧编号升序后序列化，保证顺序不同的同一映射视为一致。 */
export function canonicalMapping(entries: MappingEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.from - b.from || a.to - b.to);
  return JSON.stringify(sorted);
}

export interface PreviewTicket {
  token: string;
  revision: number;
  mapping: string;
  changeCount: number;
}

/**
 * 生成一次性预览凭证：记录当前 revision 与规范化映射。不改动正文，
 * 因此不推进 revision；同一 revision + 映射可以存在多个未消费凭证，
 * 但每个凭证至多成功确认一次（消费后即失效）。
 */
export function createRenumberPreview(
  docId: number,
  revision: number,
  entries: MappingEntry[],
  changeCount: number,
): PreviewTicket {
  const token = crypto.randomBytes(32).toString('hex');
  const mapping = canonicalMapping(entries);
  stmts
    .insertPreview()
    .run(docId, token, revision, mapping, changeCount);
  return { token, revision, mapping, changeCount };
}

export class PreviewTicketError extends Error {
  constructor(
    public code: 'PREVIEW_NOT_FOUND' | 'PREVIEW_EXPIRED' | 'PREVIEW_MAPPING_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'PreviewTicketError';
  }
}

export interface CommitPreviewResult {
  doc: DocRow;
  entries: MappingEntry[];
  changes: NonNullable<ReturnType<typeof buildPlan>['changes']>;
  newText: string;
  revision: number;
}

/**
 * 凭一次性凭证确认改号。凭证核对、映射与正文重校验、撤销历史写入、
 * 正文更新全部在同一个 IMMEDIATE 事务内完成：
 *   - 凭证不存在          → PREVIEW_NOT_FOUND
 *   - 已消费 / revision 不符 → PREVIEW_EXPIRED（正文被保存/提交/裁撤/撤销推进过）
 *   - 提交映射与凭证映射不符 → PREVIEW_MAPPING_MISMATCH
 *   - 正文重校验出现冲突    → PREVIEW_MAPPING_MISMATCH（请重新预览）
 *   - 并发确认同一凭证：条件 UPDATE 只可能命中一次，至多一次成功。
 * 任何一步失败都抛错并整体回滚——撤销历史与正文两个写入均不发生。
 */
export function commitRenumberWithTicket(
  docId: number,
  token: string,
  entries: MappingEntry[],
): CommitPreviewResult {
  const tx = getDB().transaction((): CommitPreviewResult => {
    const doc = stmts.getDoc().get(docId) as DocRow | undefined;
    if (!doc) throw new PreviewTicketError('PREVIEW_NOT_FOUND', `文档 ${docId} 不存在。`);

    const ticket = stmts.getPreview().get(docId, token) as PreviewRow | undefined;
    if (!ticket) {
      throw new PreviewTicketError(
        'PREVIEW_NOT_FOUND',
        '预览凭证不存在或已失效，请重新生成预览后再确认。',
      );
    }
    if (ticket.consumed_at) {
      throw new PreviewTicketError(
        'PREVIEW_EXPIRED',
        '该预览已确认过，不能重复提交；请重新生成预览。',
      );
    }
    if (ticket.revision !== doc.revision) {
      throw new PreviewTicketError(
        'PREVIEW_EXPIRED',
        `预览基于正文修订号 ${ticket.revision}，当前为 ${doc.revision}（正文已被保存、提交、裁撤或撤销推进），请重新生成预览。`,
      );
    }
    if (canonicalMapping(entries) !== ticket.mapping) {
      throw new PreviewTicketError(
        'PREVIEW_MAPPING_MISMATCH',
        '提交的映射与生成预览时的映射不一致，请重新生成预览后再确认。',
      );
    }

    // 事务内按当前正文重算计划：冲突则拒绝，两个写入均不发生。
    const plan = buildPlan(doc.content, entries);
    if (!plan.ok || !plan.changes || plan.newText === undefined) {
      throw new PreviewTicketError(
        'PREVIEW_MAPPING_MISMATCH',
        '按当前正文重新校验映射时存在冲突，请重新生成预览。',
      );
    }

    // 条件消费：并发下只有一个事务能把 consumed_at 置位。
    const consumed = stmts.consumePreview().run(docId, token).changes;
    if (consumed !== 1) {
      throw new PreviewTicketError('PREVIEW_EXPIRED', '预览已失效，请重新生成预览。');
    }

    stmts.insertHistory().run(
      docId,
      doc.content,
      plan.newText,
      JSON.stringify({ op: 'renumber', mapping: entries }),
      plan.changes.length,
    );
    getDB()
      .prepare(
        `UPDATE documents
           SET content = ?, revision = revision + 1, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(plan.newText, docId);

    const updated = stmts.getDoc().get(docId) as DocRow;
    return {
      doc: updated,
      entries,
      changes: plan.changes,
      newText: plan.newText,
      revision: updated.revision,
    };
  });
  return tx.immediate();
}
