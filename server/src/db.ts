// SQLite 持久化。better-sqlite3 的 transaction 提供原子性：
// 提交改号（写历史 + 更新正文）在同一事务内完成，异常即整体回滚。

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

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
        `UPDATE documents SET content = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(after, docId);
  });
  tx();
}

export function getLastHistory(docId: number): HistoryRow | undefined {
  return stmts.lastHistory().get(docId) as HistoryRow | undefined;
}

/** 撤销最近一次改号：恢复历史中的正文并弹出栈顶记录，原子完成。 */
export function undoLastRenumber(docId: number): HistoryRow | null {
  const last = getLastHistory(docId);
  if (!last) return null;
  const tx = getDB().transaction((h: HistoryRow) => {
    getDB()
      .prepare(
        `UPDATE documents SET content = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(h.before_text, h.document_id);
    stmts.deleteHistory().run(h.id);
  });
  tx(last);
  return last;
}
