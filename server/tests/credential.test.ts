// 轻量自检（不依赖测试框架）：改号预览凭证的修订号绑定、映射核对、
// 一次性消费、并发确认至多成功一次、保存原文/撤销推进修订号且旧凭证不复活。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initDB,
  createDocument,
  getDocument,
  updateDocument,
  issueRenumberPreview,
  commitRenumber,
  commitRenumberWithPreview,
  undoLastRenumber,
  getDB,
  PreviewRejectedError,
} from '../src/db';
import { buildPlan, canonicalMappingJson } from '../src/renumber';

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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'renumber-credential-'));
const dbFile = path.join(tmpDir, 'test.db');
initDB(dbFile);

const BASE = ['第一条 甲', '见第2条。', '第二条 乙', '见第1条。'].join('\n');

const planner = (content: string, mappingJson: string) => {
  const entries = JSON.parse(mappingJson) as { from: number; to: number }[];
  const plan = buildPlan(content, entries);
  return plan.ok
    ? {
        ok: true as const,
        newText: plan.newText!,
        changeCount: plan.changes!.length,
        changes: plan.changes,
        entries,
      }
    : { ok: false as const };
};

const issue = (docId: number, entries: { from: number; to: number }[]) => {
  const doc = getDocument(docId)!;
  const plan = buildPlan(doc.content, entries);
  assert.ok(plan.ok);
  return issueRenumberPreview({
    documentId: docId,
    revision: doc.revision,
    mappingJson: canonicalMappingJson(entries),
    newText: plan.newText!,
    changeCount: plan.changes!.length,
  }).token;
};

console.log('preview credential:');
check('新文档修订号从 1 开始', () => {
  const doc = createDocument('t', BASE);
  assert.equal(doc.revision, 1);
});

const docId = createDocument('合同', BASE).id;

check('凭凭证确认成功：写入正文与历史，并推进修订号', () => {
  const token = issue(docId, [
    { from: 1, to: 2 },
    { from: 2, to: 1 },
  ]);
  const result = commitRenumberWithPreview({
    documentId: docId,
    token,
    expectedMappingJson: null,
    planner,
  });
  assert.equal(result.changeCount, 4); // 2 个标题 + 2 处引用
  assert.ok(result.after.includes('第二条 甲'));
  assert.equal(getDocument(docId)!.revision, 2);
  assert.ok(undoLastRenumber(docId), '撤销历史应已写入');
  assert.equal(getDocument(docId)!.revision, 3);
});

check('同一凭证确认第二次：已消费且修订号已前进，拒绝且不再写入', () => {
  // 上一步已撤销（revision=3）；重新签发，确认成功后再用同一 token。
  const token = issue(docId, [
    { from: 1, to: 2 },
    { from: 2, to: 1 },
  ]);
  commitRenumberWithPreview({ documentId: docId, token, expectedMappingJson: null, planner });
  assert.equal(getDocument(docId)!.revision, 4);
  assert.throws(
    () =>
      commitRenumberWithPreview({
        documentId: docId,
        token,
        expectedMappingJson: null,
        planner,
      }),
    (e: unknown) => e instanceof PreviewRejectedError && e.code === 'PREVIEW_REVISION_STALE',
  );
  // 被拒后正文与修订号保持不变
  assert.equal(getDocument(docId)!.revision, 4);
  undoLastRenumber(docId); // 回到 BASE，revision=5
});

check('保存原文推进修订号：旧凭证 PREVIEW_REVISION_STALE，即使文本恢复相同也不复活', () => {
  const token = issue(docId, [{ from: 1, to: 3 }]);
  // 保存一次不同的文本
  updateDocument(docId, '合同', '临时正文');
  assert.equal(getDocument(docId)!.revision, 6);
  assert.throws(
    () =>
      commitRenumberWithPreview({
        documentId: docId,
        token,
        expectedMappingJson: null,
        planner,
      }),
    (e: unknown) => e instanceof PreviewRejectedError && e.code === 'PREVIEW_REVISION_STALE',
  );
  // 再保存回与凭证签发时完全相同的文本，凭证依然无效（修订号不回退）
  updateDocument(docId, '合同', BASE);
  assert.equal(getDocument(docId)!.revision, 7);
  assert.throws(
    () =>
      commitRenumberWithPreview({
        documentId: docId,
        token,
        expectedMappingJson: null,
        planner,
      }),
    (e: unknown) => e instanceof PreviewRejectedError && e.code === 'PREVIEW_REVISION_STALE',
  );
});

check('改号提交（无凭证旧路径）/裁撤提交同样推进修订号并使旧凭证失效', () => {
  const token = issue(docId, [{ from: 1, to: 3 }]);
  // 走无凭证旧路径的 commitRenumber（改号与裁撤共用）
  const plan = buildPlan(BASE, [
    { from: 1, to: 2 },
    { from: 2, to: 1 },
  ])!;
  commitRenumber(
    docId,
    BASE,
    plan.newText!,
    JSON.stringify({ op: 'renumber', mapping: [] }),
    plan.changes!.length,
  );
  assert.equal(getDocument(docId)!.revision, 8);
  assert.throws(
    () =>
      commitRenumberWithPreview({
        documentId: docId,
        token,
        expectedMappingJson: null,
        planner,
      }),
    (e: unknown) => e instanceof PreviewRejectedError,
  );
  undoLastRenumber(docId); // revision=9，回到 BASE
});

check('撤销推进修订号：撤销前签发的凭证在撤销后失效', () => {
  const swap = [
    { from: 1, to: 2 },
    { from: 2, to: 1 },
  ];
  const token = issue(docId, swap);
  commitRenumberWithPreview({ documentId: docId, token, expectedMappingJson: null, planner });
  // 撤销后正文恢复为 BASE（与凭证签发时逐字相同），但修订号已 +2
  undoLastRenumber(docId);
  const restored = getDocument(docId)!;
  assert.equal(restored.content, BASE);
  assert.throws(
    () =>
      commitRenumberWithPreview({
        documentId: docId,
        token,
        expectedMappingJson: null,
        planner,
      }),
    (e: unknown) => e instanceof PreviewRejectedError && e.code === 'PREVIEW_REVISION_STALE',
  );
});

check('新预览签发后旧凭证立即失效（修改映射重新预览）', () => {
  const oldToken = issue(docId, [{ from: 1, to: 3 }]);
  // 用户改了映射，重新预览
  issue(docId, [{ from: 1, to: 4 }]);
  assert.throws(
    () =>
      commitRenumberWithPreview({
        documentId: docId,
        token: oldToken,
        expectedMappingJson: null,
        planner,
      }),
    (e: unknown) => e instanceof PreviewRejectedError && e.code === 'PREVIEW_NOT_FOUND',
  );
});

check('请求携带的映射与凭证绑定映射不符：PREVIEW_MAPPING_MISMATCH，两个写入均不发生', () => {
  const token = issue(docId, [{ from: 1, to: 3 }]);
  const before = getDocument(docId)!;
  assert.throws(
    () =>
      commitRenumberWithPreview({
        documentId: docId,
        token,
        expectedMappingJson: canonicalMappingJson([{ from: 1, to: 4 }]),
        planner,
      }),
    (e: unknown) => e instanceof PreviewRejectedError && e.code === 'PREVIEW_MAPPING_MISMATCH',
  );
  const after = getDocument(docId)!;
  assert.equal(after.revision, before.revision);
  assert.equal(after.content, before.content);
  assert.equal(undoLastRenumber(docId), null, '映射不符时不得写入撤销历史');
  // 被拒后原凭证仍可按其绑定的映射正常确认（核对失败不消费凭证）
  const ok = commitRenumberWithPreview({
    documentId: docId,
    token,
    expectedMappingJson: null,
    planner,
  });
  assert.equal(ok.changeCount, 2);
});

check('不存在 / 已删除文档的凭证：PREVIEW_NOT_FOUND', () => {
  assert.throws(
    () =>
      commitRenumberWithPreview({
        documentId: docId,
        token: '00000000-0000-0000-0000-000000000000',
        expectedMappingJson: null,
        planner,
      }),
    (e: unknown) => e instanceof PreviewRejectedError && e.code === 'PREVIEW_NOT_FOUND',
  );
});

// 上一用例确认了 1→3：撤销回到 BASE，便于后续用例继续签发。
undoLastRenumber(docId);

check('同修订号下凭证已被并发事务消费：PREVIEW_CONSUMED，两个写入均不发生', () => {
  const token = issue(docId, [{ from: 1, to: 3 }]);
  const before = getDocument(docId)!;
  // 模拟并发中胜出的事务先把凭证条件消费（修订号尚未变化的瞬间）。
  getDB()
    .prepare(`UPDATE renumber_previews SET consumed = 1 WHERE token = ? AND consumed = 0`)
    .run(token);
  assert.throws(
    () =>
      commitRenumberWithPreview({
        documentId: docId,
        token,
        expectedMappingJson: null,
        planner,
      }),
    (e: unknown) => e instanceof PreviewRejectedError && e.code === 'PREVIEW_CONSUMED',
  );
  const after = getDocument(docId)!;
  assert.equal(after.revision, before.revision);
  assert.equal(undoLastRenumber(docId), null, '并发落败时不得写入撤销历史');
});

check('并发确认同一预览至多成功一次（条件消费语义）', () => {
  const token = issue(docId, [
    { from: 1, to: 2 },
    { from: 2, to: 1 },
  ]);
  // 验证服务端依赖的条件更新语义——连续两次条件消费只有第一次 changes=1
  //（better-sqlite3 的事务在 Node 侧串行执行，故并发确认至多成功一次）。
  const db2 = getDB();
  const row = db2
    .prepare(`SELECT * FROM renumber_previews WHERE document_id = ? AND token = ?`)
    .get(docId, token) as { id: number; consumed: number };
  const first = db2
    .prepare(`UPDATE renumber_previews SET consumed = 1 WHERE id = ? AND consumed = 0`)
    .run(row.id);
  const second = db2
    .prepare(`UPDATE renumber_previews SET consumed = 1 WHERE id = ? AND consumed = 0`)
    .run(row.id);
  assert.equal(first.changes, 1);
  assert.equal(second.changes, 0);
});

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\ncredential tests passed: ${passed}`);
