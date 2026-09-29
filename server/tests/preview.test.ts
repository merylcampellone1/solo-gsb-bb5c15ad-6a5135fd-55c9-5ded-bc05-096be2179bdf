// 轻量自检（不依赖测试框架）：改号预览凭证（ticket）语义。
//
// 覆盖：
//   1) revision 单调：保存原文（含相同文本）/ 提交改号 / 提交裁撤 / 撤销都推进；
//   2) 旧库迁移：无 revision 列的旧库自动补齐，存量行 revision=1；
//   3) 凭证：预览绑定 revision + 规范化映射（顺序无关），确认成功后正文与历史原子落库；
//   4) 拒绝：凭证不存在 / 已消费 / revision 过期 / 映射不符，两个写入均不发生；
//   5) 正文后来恢复相同文本不复活旧凭证（revision 不回退）；
//   6) HTTP 端到端：预览带 ticket、确认带 ticket；不带 ticket 的旧请求仍按原规则工作；
//      并发确认同一预览至多成功一次。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  initDB,
  createDocument,
  getDocument,
  updateDocument,
  commitRenumber,
  undoLastRenumber,
  createRenumberPreview,
  commitRenumberWithTicket,
  canonicalMapping,
  PreviewTicketError,
  getDB,
} from '../src/db';
import { normalizeMapping } from '../src/renumber';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    console.error(`  ❌ ${name}`);
    throw e;
  }
};

const mkTempDb = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-test-'));
  return { dir, file: path.join(dir, 'contract.db') };
};

const TEXT = [
  '第一条 总则',
  '总则见第2条。',
  '第二条 定义',
  '定义见第3条。',
  '第三条 附件',
  '附件适用第1条。',
].join('\n');

const historyCount = (docId: number) =>
  (
    getDB()
      .prepare(`SELECT COUNT(*) AS n FROM renumber_history WHERE document_id = ?`)
      .get(docId) as { n: number }
  ).n;

const norm = (rows: { from: number; to: number }[]) => normalizeMapping(rows).entries;
const swap = () =>
  norm([
    { from: 1, to: 2 },
    { from: 2, to: 1 },
  ]);

// ---------- DB 层 ----------

const { dir, file } = mkTempDb();
initDB(file);

console.log('revision 单调推进：');
const doc = createDocument('测试合同', TEXT);
check('新建文档 revision=1', () => assert.equal(doc.revision, 1));

check('保存原文（即使文本相同）推进 revision', () => {
  const updated = updateDocument(doc.id, doc.title, TEXT)!;
  assert.equal(updated.revision, 2);
  const again = updateDocument(doc.id, doc.title, TEXT)!;
  assert.equal(again.revision, 3);
});

let currentRev = 3;

console.log('凭证生命周期：');
check('正常确认：事务内核对通过，正文与撤销历史原子写入，revision+1', () => {
  const entries = swap();
  const ticket = createRenumberPreview(doc.id, currentRev, entries, entries.length * 4);
  const result = commitRenumberWithTicket(doc.id, ticket.token, entries);
  assert.equal(result.revision, currentRev + 1);
  assert.ok(result.doc.content.includes('第二条 总则'));
  assert.ok(result.doc.content.includes('第一条 定义'));
  assert.equal(historyCount(doc.id), 1);
  currentRev = result.revision;
});

check('撤销推进 revision；正文恢复相同文本也不复活旧凭证', () => {
  const undone = undoLastRenumber(doc.id)!;
  assert.ok(undone);
  const restored = getDocument(doc.id)!;
  assert.equal(restored.revision, currentRev + 1);
  assert.equal(restored.content, TEXT);
  currentRev = restored.revision;
  // 撤销恢复的文本与最初一致，但此前预览凭证绑定的 revision 已远落后。
  const stale = createRenumberPreview(doc.id, 1, swap(), 0);
  assert.throws(
    () => commitRenumberWithTicket(doc.id, stale.token, swap()),
    (e: unknown) => e instanceof PreviewTicketError && e.code === 'PREVIEW_EXPIRED',
  );
});

check('重复确认同一凭证：第二次拒绝（PREVIEW_EXPIRED），不再产生写入', () => {
  const entries = swap();
  const ticket = createRenumberPreview(doc.id, currentRev, entries, 0);
  commitRenumberWithTicket(doc.id, ticket.token, entries);
  const before = getDocument(doc.id)!;
  const beforeHistory = historyCount(doc.id);
  assert.throws(
    () => commitRenumberWithTicket(doc.id, ticket.token, entries),
    (e: unknown) => e instanceof PreviewTicketError && e.code === 'PREVIEW_EXPIRED',
  );
  const after = getDocument(doc.id)!;
  assert.equal(after.revision, before.revision);
  assert.equal(historyCount(doc.id), beforeHistory);
  currentRev = before.revision;
});

check('映射不符：拒绝（PREVIEW_MAPPING_MISMATCH），凭证仍可按原映射确认一次', () => {
  const entries = swap();
  const ticket = createRenumberPreview(doc.id, currentRev, entries, 0);
  const changed = norm([
    { from: 2, to: 3 },
    { from: 3, to: 2 },
  ]);
  const beforeHistory = historyCount(doc.id);
  assert.throws(
    () => commitRenumberWithTicket(doc.id, ticket.token, changed),
    (e: unknown) => e instanceof PreviewTicketError && e.code === 'PREVIEW_MAPPING_MISMATCH',
  );
  assert.equal(historyCount(doc.id), beforeHistory, '映射不符不得写撤销历史');
  // 失败未消费凭证：按原映射确认成功。
  const result = commitRenumberWithTicket(doc.id, ticket.token, entries);
  assert.equal(result.revision, currentRev + 1);
  currentRev = result.revision;
});

check('规范化映射与行序无关（1→2、2→1 与 2→1、1→2 视为同一映射）', () => {
  assert.equal(canonicalMapping(norm([{ from: 2, to: 1 }, { from: 1, to: 2 }])),
    canonicalMapping(swap()));
  const entriesReordered = norm([{ from: 2, to: 1 }, { from: 1, to: 2 }]);
  const ticket = createRenumberPreview(doc.id, currentRev, swap(), 0);
  const result = commitRenumberWithTicket(doc.id, ticket.token, entriesReordered);
  assert.equal(result.revision, currentRev + 1);
  currentRev = result.revision;
});

check('凭证不存在：PREVIEW_NOT_FOUND', () => {
  assert.throws(
    () => commitRenumberWithTicket(doc.id, 'not-a-real-token', swap()),
    (e: unknown) => e instanceof PreviewTicketError && e.code === 'PREVIEW_NOT_FOUND',
  );
});

check('保存原文后旧凭证过期，且两个写入均不发生', () => {
  const entries = swap();
  const ticket = createRenumberPreview(doc.id, currentRev, entries, 0);
  updateDocument(doc.id, doc.title, getDocument(doc.id)!.content);
  const before = getDocument(doc.id)!;
  const beforeHistory = historyCount(doc.id);
  assert.throws(
    () => commitRenumberWithTicket(doc.id, ticket.token, entries),
    (e: unknown) => e instanceof PreviewTicketError && e.code === 'PREVIEW_EXPIRED',
  );
  const after = getDocument(doc.id)!;
  assert.equal(after.revision, before.revision);
  assert.equal(historyCount(doc.id), beforeHistory);
  currentRev = after.revision;
});

check('裁撤提交（共用历史入口）推进 revision，使旧凭证过期', () => {
  const entries = swap();
  const ticket = createRenumberPreview(doc.id, currentRev, entries, 0);
  // 直接复用通用提交入口模拟裁撤（index 层 removal/commit 走同一函数）。
  commitRenumber(doc.id, getDocument(doc.id)!.content, getDocument(doc.id)!.content,
    JSON.stringify({ op: 'remove', deletes: [], replacements: [] }), 0);
  assert.throws(
    () => commitRenumberWithTicket(doc.id, ticket.token, entries),
    (e: unknown) => e instanceof PreviewTicketError && e.code === 'PREVIEW_EXPIRED',
  );
});

// ---------- 旧库迁移 ----------

console.log('旧库迁移：');
check('无 revision 列的旧 documents 表启动后自动补齐，存量行 revision=1', () => {
  const { dir: dir2, file: file2 } = mkTempDb();
  const old = new Database(file2);
  old.exec(`
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '未命名合同',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE renumber_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      before_text TEXT NOT NULL,
      after_text TEXT NOT NULL,
      mapping TEXT NOT NULL,
      change_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO documents (title, content) VALUES ('旧合同', '第一条 旧');
  `);
  old.close();
  // initDB 操作全局单例，迁移校验同样生效。
  initDB(file2);
  const migrated = getDocument(1)!;
  assert.equal(migrated.revision, 1);
  assert.equal(migrated.content, '第一条 旧');
  const bumped = updateDocument(1, '旧合同', '第一条 旧改')!;
  assert.equal(bumped.revision, 2);
  fs.rmSync(dir2, { recursive: true, force: true });
});

// ---------- HTTP 端到端（动态拉起现有 Express 服务） ----------

async function httpEndToEnd() {
  console.log('HTTP 端到端：');
  const { dir: dir3, file: file3 } = mkTempDb();
  process.env.DB_PATH = file3;
  process.env.PORT = '13937';
  process.env.HOST = '127.0.0.1';
  await import('../src/index');
  const base = 'http://127.0.0.1:13937';

  const create = async () => {
    const res = await fetch(`${base}/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'HTTP 合同', content: TEXT }),
    });
    const data = await res.json();
    return { id: data.document.id as number, revision: data.document.revision as number };
  };

  const preview = async (id: number, mapping: unknown) => {
    const res = await fetch(`${base}/api/documents/${id}/renumber/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapping }),
    });
    return { status: res.status, body: await res.json() };
  };

  const commit = async (id: number, body: unknown) => {
    const res = await fetch(`${base}/api/documents/${id}/renumber/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  await new Promise((r) => setTimeout(r, 100));

  const a = await checkAsync('预览返回 revision 与一次性 ticket', async () => {
    const d = await create();
    const p = await preview(d.id, swap());
    assert.equal(p.status, 200);
    assert.equal(p.body.revision, 1);
    assert.equal(typeof p.body.ticket, 'string');
    assert.ok(p.body.ticket.length > 0);
    return { d, p };
  });

  await checkAsync('工作台确认带 ticket：成功，revision 推进', async () => {
    const c = await commit(a.d.id, { mapping: swap(), ticket: a.p.body.ticket });
    assert.equal(c.status, 200);
    assert.equal(c.body.revision, 2);
    assert.ok(c.body.document.content.includes('第二条 总则'));
  });

  await checkAsync('不带 ticket 的旧请求仍按原有校验、响应规则工作', async () => {
    const d = await create();
    const c = await commit(d.id, { mapping: swap() });
    assert.equal(c.status, 200);
    assert.equal(c.body.revision, 2);
    // 旧路径的冲突响应也保持原样（1→3 撞上未参与映射的第3条）。
    const d2 = await create();
    const bad = await commit(d2.id, { mapping: [{ from: 1, to: 3 }] });
    assert.equal(bad.status, 409);
    assert.equal(bad.body.error.code, 'RENUMBER_CONFLICT');
  });

  await checkAsync('未知 ticket：409 PREVIEW_NOT_FOUND', async () => {
    const d = await create();
    const c = await commit(d.id, { mapping: swap(), ticket: 'deadbeef' });
    assert.equal(c.status, 409);
    assert.equal(c.body.error.code, 'PREVIEW_NOT_FOUND');
  });

  await checkAsync('正文被保存后带旧 ticket 确认：409 PREVIEW_EXPIRED，无写入', async () => {
    const d = await create();
    const p = await preview(d.id, swap());
    const put = await fetch(`${base}/api/documents/${d.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'HTTP 合同', content: TEXT }),
    });
    assert.equal(put.ok, true);
    const c = await commit(d.id, { mapping: swap(), ticket: p.body.ticket });
    assert.equal(c.status, 409);
    assert.equal(c.body.error.code, 'PREVIEW_EXPIRED');
    const got = await (await fetch(`${base}/api/documents/${d.id}`)).json();
    assert.equal(got.document.content, TEXT);
    assert.equal(got.document.revision, 2);
  });

  await checkAsync('映射不符：409 PREVIEW_MAPPING_MISMATCH；随后按原映射仍可确认', async () => {
    const d = await create();
    const p = await preview(d.id, swap());
    const other = norm([
      { from: 2, to: 3 },
      { from: 3, to: 2 },
    ]);
    const bad = await commit(d.id, { mapping: other, ticket: p.body.ticket });
    assert.equal(bad.status, 409);
    assert.equal(bad.body.error.code, 'PREVIEW_MAPPING_MISMATCH');
    const ok = await commit(d.id, { mapping: swap(), ticket: p.body.ticket });
    assert.equal(ok.status, 200);
  });

  await checkAsync('并发确认同一预览：至多成功一次，revision 只推进一次', async () => {
    const d = await create();
    const p = await preview(d.id, swap());
    const [r1, r2] = await Promise.all([
      commit(d.id, { mapping: swap(), ticket: p.body.ticket }),
      commit(d.id, { mapping: swap(), ticket: p.body.ticket }),
    ]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409]);
    const failed = r1.status === 409 ? r1 : r2;
    assert.equal(failed.body.error.code, 'PREVIEW_EXPIRED');
    const got = await (await fetch(`${base}/api/documents/${d.id}`)).json();
    assert.equal(got.document.revision, 2);
  });

  fs.rmSync(dir3, { recursive: true, force: true });
}

async function checkAsync(name: string, fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    passed++;
    console.log(`  ✅ ${name}`);
    return result;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    throw e;
  }
}

await httpEndToEnd();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n预览凭证测试全部通过：${passed} 项 ✅`);
process.exit(0);
