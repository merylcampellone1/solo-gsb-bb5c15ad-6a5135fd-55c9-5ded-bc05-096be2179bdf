// 版本对照引擎自检（不依赖测试框架）：
// 覆盖去编号 + 空白规范化、内容唯一跨编号匹配（仅改号）、同号内容修改、
// 新增 / 删除、重复内容多候选待确认、同号多标题待确认、无变化，以及顺序稳定。

import assert from 'node:assert';
import { diffVersions, splitClauses } from '../src/diff';

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

const build = (bodies: string[]) =>
  ['合同标题', '', ...bodies].join('\n');

const clause = (n: number, title: string, body: string) =>
  [`第${n}条 ${title}`, body, ''].join('\n');

// 旧稿：1 总则 / 2 定义 / 3 服务 / 4 验收
const oldText = build([
  clause(1, '总则', '本合同依据法律订立。'),
  clause(2, '定义', '术语解释适用第1条。'),
  clause(3, '服务范围', '乙方提供运维服务。'),
  clause(4, '验收', '验收后结算费用。'),
]);

// 新稿：
//  - 第1条总则原样（无变化）
//  - 原“第2条 定义”改号为第3条，内容不变（仅改号，跨编号内容唯一匹配）
//  - 原“第3条 服务范围”编号不变，正文修改（唯一同号配对 = 内容修改）
//  - 原“第4条 验收”删除
//  - 新增“第5条 保密”
const newText = build([
  clause(1, '总则', '本合同依据法律订立。'),
  clause(3, '服务范围', '乙方提供运维与巡检服务。'),
  clause(5, '定义', '术语解释适用第1条。'),
  clause(8, '保密', '双方负有保密义务。'),
]);

console.log('diff core:');
const diff = diffVersions(oldText, newText);

check('按标题边界拆出 4 / 4 个条款', () => {
  assert.equal(splitClauses(oldText).length, 4);
  assert.equal(diff.oldClauseCount, 4);
  assert.equal(diff.newClauseCount, 4);
});

check('计数：新增1 删除1 修改1 仅改号1 无变化1，无待确认', () => {
  assert.deepEqual(diff.counts, {
    added: 1,
    removed: 1,
    modified: 1,
    renumbered: 1,
    unchanged: 1,
    ambiguous: 0,
  });
});

check('内容唯一匹配跨编号：旧2 定义 → 新5 定义 = 仅改号', () => {
  const p = diff.pairs.find((x) => x.old?.number === 2 && x.old.heading.includes('定义'))!;
  assert.equal(p.status, 'renumbered');
  assert.equal(p.new!.number, 5);
  assert.equal(p.old!.contentKey, p.new!.contentKey);
});

check('同号唯一配对 + 内容差异：旧3 服务（编号不变）= 内容修改', () => {
  const p = diff.pairs.find((x) => x.old?.number === 3 && x.old.heading.includes('服务'))!;
  assert.equal(p.status, 'modified');
  assert.equal(p.new!.number, 3);
  assert.notEqual(p.old!.contentKey, p.new!.contentKey);
});

check('删除：旧第4条验收无配对；新增：新第8条保密无旧稿', () => {
  const removed = diff.pairs.find((p) => p.status === 'removed')!;
  assert.equal(removed.old!.number, 4);
  assert.equal(removed.old!.heading, '第4条 验收');
  assert.equal(removed.new, null);
  const added = diff.pairs.find((p) => p.status === 'added')!;
  assert.equal(added.new!.number, 8);
  assert.equal(added.new!.heading, '第8条 保密');
  assert.equal(added.old, null);
});

check('无变化：编号与内容键均相同', () => {
  const p = diff.pairs.find((x) => x.status === 'unchanged')!;
  assert.equal(p.old!.number, 1);
  assert.equal(p.new!.number, 1);
});

check('结果按旧稿顺序排列，新增条款排在最后', () => {
  const orders = diff.pairs.map((p) => p.old?.order ?? 999);
  const sorted = [...orders].sort((a, b) => a - b);
  assert.deepEqual(orders, sorted);
  assert.equal(diff.pairs[diff.pairs.length - 1].status, 'added');
});

check('每条配对携带两版编号、标题与原文片段', () => {
  const p = diff.pairs.find((x) => x.status === 'renumbered')!;
  assert.ok(p.old!.snippet.includes('术语解释适用'));
  assert.ok(p.new!.snippet.includes('术语解释适用'));
  assert.ok(p.old!.heading.startsWith('第2条'));
  assert.ok(p.new!.heading.startsWith('第5条'));
});

console.log('diff normalization:');
check('标题编号差异与空白（含全角空格/换行/缩进）规范化后仍能唯一匹配', () => {
  const o = build([clause(1, '总则', '本合同依据法律订立。')]);
  // 标题编号换成中文、正文改缩进/全角空格/换行，文字不变
  const n = [
    '合同标题',
    '',
    '　第一条　总则',
    '  本合同依据法律订立。 ',
    '',
    '',
  ].join('\n');
  const d = diffVersions(o, n);
  assert.equal(d.counts.unchanged, 1);
  assert.equal(d.counts.added, 0);
  assert.equal(d.counts.removed, 0);
});

console.log('diff ambiguity:');
check('重复内容形成多候选：列为待确认 duplicate_content，不擅自配对', () => {
  // 旧稿两条标题文字与正文完全相同（复制粘贴导致，仅编号不同），新稿有一条相同内容
  const o = build([
    clause(1, '合同文本', '双方各执一份合同。'),
    clause(2, '合同文本', '双方各执一份合同。'),
  ]);
  const n = build([clause(5, '合同文本', '双方各执一份合同。')]);
  const d = diffVersions(o, n);
  assert.equal(d.ambiguous.length, 1);
  assert.equal(d.ambiguous[0].reason, 'duplicate_content');
  assert.equal(d.ambiguous[0].old.length, 2);
  assert.equal(d.ambiguous[0].new.length, 1);
  // 三条都不能被自动配对为新增/删除/修改
  assert.equal(d.pairs.filter((p) => p.status !== 'unchanged').length, 0);
});

check('正文相同但条标文字不同：不视为重复内容，按各自条标区分', () => {
  const o = build([
    clause(1, '甲方义务', '双方各执一份合同。'),
    clause(2, '乙方义务', '双方各执一份合同。'),
  ]);
  const n = build([clause(9, '甲方义务', '双方各执一份合同。')]);
  const d = diffVersions(o, n);
  // 第1条 甲方义务 跨号唯一匹配 = 仅改号；第2条 乙方义务 删除
  assert.equal(d.ambiguous.length, 0);
  assert.equal(d.counts.renumbered, 1);
  assert.equal(d.counts.removed, 1);
});

check('同编号标题在两侧各出现但内容键唯一：先内容配对，剩余唯一同号判为修改', () => {
  const o = build([
    clause(1, '总则', '内容A。'),
    clause(1, '附则', '内容B。'),
  ]);
  const n = build([
    clause(1, '总则', '内容A改了。'),
    clause(1, '附则', '内容B。'),
  ]);
  const d = diffVersions(o, n);
  // “内容B。”两侧唯一 -> 内容轮匹配（unchanged）
  assert.equal(d.counts.unchanged, 1);
  // 剩余两条第1条在两侧各一 -> 唯一同号配对 -> modified
  assert.equal(d.counts.modified, 1);
  assert.equal(d.ambiguous.length, 0);
});

check('同编号两侧均有多条剩余标题时不擅自挑选，归入待确认', () => {
  // 两个同号标题、各自内容键在对侧不存在 → 内容轮不匹配，
  // 同号轮两侧各 2 条候选 → duplicate_number 待确认。
  const o = build([
    clause(3, '甲', '旧稿独有内容甲。'),
    clause(3, '乙', '旧稿独有内容乙。'),
  ]);
  const n = build([
    clause(3, '丙', '新稿独有内容丙。'),
    clause(3, '丁', '新稿独有内容丁。'),
  ]);
  const d = diffVersions(o, n);
  assert.equal(d.ambiguous.length, 1);
  assert.equal(d.ambiguous[0].reason, 'duplicate_number');
  assert.equal(d.ambiguous[0].number, 3);
  assert.equal(d.ambiguous[0].old.length, 2);
  assert.equal(d.ambiguous[0].new.length, 2);
  // 不允许任何一条被自动归类为新增/删除
  assert.equal(d.pairs.length, 0);
});

check('同号多候选与跨号唯一匹配可并存：唯一内容照常配对', () => {
  const o = build([
    clause(1, '总则', '共同的总则内容。'),
    clause(3, '甲', '旧稿独有内容甲。'),
    clause(3, '乙', '旧稿独有内容乙。'),
  ]);
  const n = build([
    clause(8, '总则', '共同的总则内容。'),
    clause(3, '丙', '新稿独有内容丙。'),
    clause(3, '丁', '新稿独有内容丁。'),
  ]);
  const d = diffVersions(o, n);
  // 总则跨号唯一匹配 = 仅改号；两个第3条进入同号待确认
  assert.equal(d.counts.renumbered, 1);
  assert.equal(d.ambiguous.length, 1);
  assert.equal(d.ambiguous[0].reason, 'duplicate_number');
});

check('仅旧稿存在同号重复标题且新稿无同号：列为待确认，不自动删除', () => {
  const o = build([
    clause(7, '甲', '旧稿第七条甲。'),
    clause(7, '乙', '旧稿第七条乙。'),
  ]);
  const n = build([clause(1, '新稿独有', '新稿内容。')]);
  const d = diffVersions(o, n);
  assert.equal(d.ambiguous.length, 1);
  assert.equal(d.ambiguous[0].reason, 'duplicate_number');
  assert.equal(d.ambiguous[0].number, 7);
  assert.equal(d.ambiguous[0].old.length, 2);
  assert.equal(d.ambiguous[0].new.length, 0);
  // 两个第7条不得被计为删除；新稿第1条正常新增
  assert.equal(d.counts.removed, 0);
  assert.equal(d.counts.added, 1);
});

check('仅新稿存在同号重复标题且旧稿无同号：列为待确认，不自动新增', () => {
  const o = build([clause(1, '旧稿独有', '旧稿内容。')]);
  const n = build([
    clause(9, '丙', '新稿第九条丙。'),
    clause(9, '丁', '新稿第九条丁。'),
  ]);
  const d = diffVersions(o, n);
  assert.equal(d.ambiguous.length, 1);
  assert.equal(d.ambiguous[0].reason, 'duplicate_number');
  assert.equal(d.ambiguous[0].number, 9);
  assert.equal(d.ambiguous[0].new.length, 2);
  assert.equal(d.counts.added, 0);
  assert.equal(d.counts.removed, 1);
});

check('新稿存在缺失引用时在 newIssues 中报告，不影响对照输出', () => {
  const n = build([
    clause(1, '总则', '参见第九十九条。'),
  ]);
  const d = diffVersions(oldText, n);
  assert.ok(d.newIssues.some((i) => i.kind === 'missing_reference' && i.number === 99));
  assert.equal(d.pairs.length >= 1, true);
});

console.log(`\ndiff tests: ${passed} passed`);
