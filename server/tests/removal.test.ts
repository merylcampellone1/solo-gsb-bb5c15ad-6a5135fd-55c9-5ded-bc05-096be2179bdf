// 条款裁撤引擎自检（不依赖测试框架）：
// 覆盖相邻标题裁撤、引用图与传递影响、循环引用、多条同时删除、
// 未处理引用/替代目标在删除集合/重复定义/缺失定义拒绝、中文风格保留，
// 以及 SQLite 单事务提交 + 沿用撤销入口的回滚恢复。

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeRemoval, buildRemovalPlan, normalizeRemovalRequest } from '../src/removal';
import { initDB, createDocument, commitRenumber, undoLastRenumber, getDocument } from '../src/db';

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

// 条款 1..5，区块间含空行；引用链：2->1、3->2、4->5、5->4（循环）
const text = [
  '技术服务合同',
  '',
  '第一条 总则',
  '本合同依据相关法律订立。',
  '',
  '第二条 定义',
  '术语解释适用第1条。',
  '',
  '第三条 履行',
  '履行中术语按第2条解释。',
  '',
  '第四条 验收',
  '验收后费用见第5条。',
  '',
  '第五条 费用',
  '费用与验收（第4条）一并处理。',
].join('\n');

console.log('removal graph:');
const impact = analyzeRemoval(text, [1]);
check('直接引用：第2条区块内引用第1条，位置准确', () => {
  assert.equal(impact.directReferences.length, 1);
  const d = impact.directReferences[0];
  assert.equal(d.number, 1);
  assert.equal(d.ownerNumber, 2);
  // “术语解释适用第1条。” 在第 7 行，第1条 token 起始列 7
  assert.equal(d.pos.line, 7);
  assert.equal(text.split('\n')[6][d.pos.column - 1], '第');
});

check('传递影响：第3条经 3→2→1 受影响且非直接；第2条为直接', () => {
  const byNum = new Map(impact.impacted.map((i) => [i.number, i]));
  assert.ok(byNum.has(2));
  assert.ok(byNum.has(3));
  assert.equal(byNum.get(2)!.direct, true);
  assert.equal(byNum.get(3)!.direct, false);
  assert.deepEqual(byNum.get(3)!.paths[0], [3, 2, 1]);
  // 第4、5条仅互引，均不可达第1条
  assert.ok(!byNum.has(4));
  assert.ok(!byNum.has(5));
});

check('循环引用 4↔5：裁第4条时影响分析不死循环，第5条直接受影响', () => {
  const imp = analyzeRemoval(text, [4]);
  const five = imp.impacted.find((i) => i.number === 5);
  assert.ok(five, '第5条应受影响');
  assert.equal(five!.direct, true);
  assert.deepEqual(five!.paths[0], [5, 4]);
});

console.log('removal build:');
check('无引用条款可直接裁撤，删除区块含标题/正文/尾随空行', () => {
  const t = ['第一条 甲', '内容一。', '', '第二条 乙', '内容二。'].join('\n');
  // 第1条无任何引用
  assert.deepEqual(analyzeRemoval(t, [1]).unreferenced, [1]);
  const plan = buildRemovalPlan(t, [1], []);
  assert.ok(plan.ok);
  assert.equal(plan.blocks!.length, 1);
  assert.equal(plan.blocks![0].number, 1);
  assert.equal(plan.newText, '第二条 乙\n内容二。');
  assert.equal(plan.changes!.length, 0);
});

check('相邻标题裁撤：不留空行，下一条紧接文首', () => {
  const t = ['序言', '第一条 甲', '内容一。', '第二条 乙', '内容二。'].join('\n');
  const plan = buildRemovalPlan(t, [1], []);
  assert.ok(plan.ok);
  assert.equal(plan.newText, '序言\n第二条 乙\n内容二。');
  const block = plan.blocks![0];
  assert.equal(block.startLine, 2);
  assert.equal(block.next!.number, 2);
  assert.equal(block.prev, null, '第一条之前只有序言，无相邻条款');
});

check('末条裁撤：原文以换行结尾时，收敛多余空行并保留单个换行', () => {
  const t = '第一条 甲\n内容一。\n\n第二条 乙\n按第1条办。\n';
  const plan = buildRemovalPlan(t, [1], [{ from: 1, to: 2 }]);
  assert.ok(plan.ok);
  assert.equal(plan.newText, '第二条 乙\n按第2条办。\n');
});

check('单条裁撤：幸存引用逐处替换为替代条款，风格沿用原文', () => {
  const plan = buildRemovalPlan(text, [1], [{ from: 1, to: 3 }]);
  assert.ok(plan.ok);
  assert.equal(plan.blocks!.length, 1);
  assert.equal(plan.changes!.length, 1);
  const c = plan.changes![0];
  assert.equal(c.fromNumber, 1);
  assert.equal(c.toNumber, 3);
  assert.equal(c.before, '第1条');
  assert.equal(c.after, '第3条');
  assert.ok(plan.newText!.includes('术语解释适用第3条。'));
  // 删除区块：第一条标题与正文消失，第二条上移
  assert.ok(!plan.newText!.includes('第一条 总则'));
  assert.ok(plan.newText!.includes('第二条 定义'));
});

check('阿拉伯引用替换保持阿拉伯风格', () => {
  const t = ['第1条 甲', '内容。', '第2条 乙', '按第1条办。'].join('\n');
  const plan = buildRemovalPlan(t, [1], [{ from: 1, to: 2 }]);
  assert.ok(plan.ok);
  assert.equal(plan.changes![0].after, '第2条');
  assert.ok(plan.newText!.includes('按第2条办。'));
});

check('中文引用替换保持中文风格', () => {
  const t = ['第一条 甲', '内容。', '第二条 乙', '按第一条办。'].join('\n');
  const plan = buildRemovalPlan(t, [1], [{ from: 1, to: 2 }]);
  assert.ok(plan.ok);
  assert.equal(plan.changes![0].after, '第二条');
  assert.ok(plan.newText!.includes('按第二条办。'));
});

check('多条同时删除：区块全部移除；幸存引用按各自映射替换', () => {
  // 第2条对第1条的引用位于待删区块内、随区块消失，故只需映射幸存的 2->5
  const plan = buildRemovalPlan(text, [1, 2], [{ from: 2, to: 5 }]);
  assert.ok(plan.ok);
  assert.equal(plan.blocks!.length, 2);
  const out = plan.newText!;
  assert.ok(!out.includes('第一条 总则'));
  assert.ok(!out.includes('第二条 定义'));
  // 第3条区块幸存，原“按第2条解释”改为第5条
  assert.ok(out.includes('第三条 履行'));
  assert.ok(out.includes('履行中术语按第5条解释。'), out);
  // 第4、5条均保留
  assert.ok(out.includes('第四条 验收') && out.includes('第五条 费用'));
});

check('多条删除时删除区块内部的互引无需映射', () => {
  // 第1、2条互引且均被删除：无任何幸存引用，无需 replacements
  const t = ['第一条 甲', '见第2条。', '第二条 乙', '见第1条。', '第三条 丙', '无关。'].join('\n');
  const plan = buildRemovalPlan(t, [1, 2], []);
  assert.ok(plan.ok);
  assert.equal(plan.newText, '第三条 丙\n无关。');
});

check('删除区块之间的相邻标题：next/prev 指向原文相邻条款', () => {
  const plan = buildRemovalPlan(text, [2], [{ from: 2, to: 1 }]);
  const block = plan.blocks![0];
  assert.equal(block.prev!.number, 1);
  assert.equal(block.next!.number, 3);
});

check('序言中的引用也算直接引用且必须映射，但序言不产生受影响条款', () => {
  const t = ['鉴于安排见第1条所述，', '', '第一条 甲', '内容。', '第二条 乙', '内容。'].join('\n');
  const imp = analyzeRemoval(t, [1]);
  assert.equal(imp.directReferences.length, 1);
  assert.equal(imp.directReferences[0].ownerNumber, null);
  assert.equal(imp.impacted.length, 0, '序言不是条款，不应出现在受影响列表');
  // 未映射 -> 拒绝（位置在序言行）
  const bad = buildRemovalPlan(t, [1], []);
  assert.ok(!bad.ok);
  const c = bad.conflicts!.find((x) => x.code === 'UNRESOLVED_REFERENCE');
  assert.equal(c!.positions![0].line, 1);
  // 映射到第2条 -> 通过
  const plan = buildRemovalPlan(t, [1], [{ from: 1, to: 2 }]);
  assert.ok(plan.ok);
  assert.ok(plan.newText!.startsWith('鉴于安排见第2条所述，'));
  assert.ok(!plan.newText!.includes('第一条 甲'));
});

console.log('removal conflicts:');
check('未处理引用 -> 拒绝且按行列返回全部位置', () => {
  const plan = buildRemovalPlan(text, [1], []);
  assert.ok(!plan.ok);
  const c = plan.conflicts!.find((x) => x.code === 'UNRESOLVED_REFERENCE');
  assert.ok(c);
  assert.equal(c!.from, 1);
  assert.ok(c!.positions!.length >= 1);
  assert.ok(c!.positions![0].line > 0 && c!.positions![0].column > 0);
});

check('替代目标也在删除集合 -> REPLACEMENT_DELETED 拒绝', () => {
  const plan = buildRemovalPlan(text, [1, 2], [
    { from: 1, to: 2 },
    { from: 2, to: 3 },
  ]);
  assert.ok(!plan.ok);
  assert.ok(plan.conflicts!.some((c) => c.code === 'REPLACEMENT_DELETED'));
});

check('替代目标未定义 -> REPLACEMENT_UNDEFINED 拒绝', () => {
  const plan = buildRemovalPlan(text, [1], [{ from: 1, to: 99 }]);
  assert.ok(!plan.ok);
  assert.ok(plan.conflicts!.some((c) => c.code === 'REPLACEMENT_UNDEFINED'));
});

check('待删编号无标题定义 -> DELETE_NOT_DEFINED 拒绝', () => {
  const plan = buildRemovalPlan(text, [42], []);
  assert.ok(!plan.ok);
  assert.ok(plan.conflicts!.some((c) => c.code === 'DELETE_NOT_DEFINED'));
});

check('重复定义 -> DUPLICATE_DEFINITION 拒绝并给出每处标题位置', () => {
  const t = [
    '第一条 甲',
    '内容。',
    '第二条 乙',
    '另见第1条。',
    '第一条 重复',
    '误粘贴。',
  ].join('\n');
  const plan = buildRemovalPlan(t, [2], [{ from: 2, to: 1 }]);
  assert.ok(!plan.ok);
  const c = plan.conflicts!.find((x) => x.code === 'DUPLICATE_DEFINITION');
  assert.ok(c);
  assert.deepEqual(c!.positions!.map((p) => p.line), [1, 5]);
});

check('缺失定义（引用了不存在的条款）-> MISSING_DEFINITION 拒绝带位置', () => {
  const t = ['第一条 甲', '内容。', '第二条 乙', '另见第99条。'].join('\n');
  const plan = buildRemovalPlan(t, [1], [{ from: 1, to: 2 }]);
  assert.ok(!plan.ok);
  const c = plan.conflicts!.find((x) => x.code === 'MISSING_DEFINITION');
  assert.ok(c);
  assert.equal(c!.from, 99);
  assert.equal(c!.positions![0].line, 4);
});

check('空选择 / 非法编号 / 同一待删条款多个替代 -> 输入校验拒绝', () => {
  assert.ok(normalizeRemovalRequest({ deletes: [] }).errors.some((e) => e.code === 'EMPTY_SELECTION'));
  assert.ok(
    normalizeRemovalRequest({ deletes: ['x'] }).errors.some((e) => e.code === 'INVALID_NUMBER'),
  );
  assert.ok(
    normalizeRemovalRequest({
      deletes: [1],
      replacements: [
        { from: 1, to: 2 },
        { from: 1, to: 3 },
      ],
    }).errors.some((e) => e.code === 'DUP_REPLACE_SOURCE'),
  );
});

check('多余的替代映射（幸存侧无引用）-> UNNEEDED_REPLACEMENT', () => {
  const t = ['第一条 甲', '内容。', '第二条 乙', '内容。'].join('\n');
  const plan = buildRemovalPlan(t, [1], [{ from: 1, to: 2 }]);
  assert.ok(!plan.ok);
  assert.ok(plan.conflicts!.some((c) => c.code === 'UNNEEDED_REPLACEMENT'));
});

console.log('removal persistence:');
check('单事务提交 + 沿用撤销入口恢复裁撤前文本', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'removal-db-'));
  const dbFile = path.join(dir, 'test.db');
  initDB(dbFile);
  const doc = createDocument('测试合同', text);
  const plan = buildRemovalPlan(text, [1], [{ from: 1, to: 3 }]);
  assert.ok(plan.ok);

  commitRenumber(
    doc.id,
    text,
    plan.newText!,
    JSON.stringify({ op: 'remove', deletes: [1], replacements: [{ from: 1, to: 3 }] }),
    plan.changes!.length,
  );
  const after = getDocument(doc.id)!;
  assert.ok(!after.content.includes('第一条 总则'));
  assert.ok(after.content.includes('术语解释适用第3条。'));

  const undone = undoLastRenumber(doc.id);
  assert.ok(undone);
  assert.equal(undone!.before_text, text);
  const restored = getDocument(doc.id)!;
  assert.equal(restored.content, text, '撤销后正文应与裁撤前逐字一致');

  // 栈式：撤销后再撤销应返回 null
  assert.equal(undoLastRenumber(doc.id), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n裁撤测试全部通过：${passed} 项 ✅`);
