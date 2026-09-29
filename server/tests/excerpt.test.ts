// 条款摘录引擎自检（不依赖测试框架）：
// 覆盖递归收齐、循环引用只收录一次、按原文顺序拼接、逐字保留区块原文、
// 不带入序言与未引用条款、空选择 / 未定义起点 / 重复标题（可达与不可达）/
// 可达缺失引用（直接与传递、序言不算）拒绝、输入去重与非法编号、行首缩进标题。

import assert from 'node:assert';
import { buildExcerpt, normalizeExcerptRequest } from '../src/excerpt';

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

// 引用链：2->1、3->2（传递依赖 1）、4<->5（循环）；6 与谁都不相关。
const text = [
  '技术服务合同（无冲突示例）',
  '',
  '第一条 总则',
  '本合同由甲乙双方依据相关法律订立。',
  '',
  '第二条 定义',
  '本合同术语的含义适用第1条的解释原则。',
  '',
  '第三条 服务范围',
  '乙方提供的服务以第2条确认的需求文件为准。',
  '',
  '第四条 验收',
  '验收通过后的费用结算见第5条。',
  '',
  '第五条 费用与结算',
  '甲方应在第4条验收通过后十五个工作日内支付费用。',
  '',
  '第六条 争议解决',
  '因本合同产生的争议，协商不成的提交仲裁。',
].join('\n');

console.log('excerpt build:');
check('单选起点：沿引用递归收齐（3 -> 2 -> 1），顺序按原文排列', () => {
  const r = buildExcerpt(text, [3]);
  assert.ok(r.ok);
  assert.deepEqual(r.excerpt!.selected, [3]);
  assert.deepEqual(r.excerpt!.reached, [1, 2, 3]);
  assert.equal(r.excerpt!.count, 3);
  const t = r.excerpt!.text;
  assert.ok(t.startsWith('第一条 总则\n本合同由甲乙双方依据相关法律订立。'), t);
  assert.ok(t.includes('第二条 定义\n本合同术语的含义适用第1条的解释原则。'));
  assert.ok(t.endsWith('第三条 服务范围\n乙方提供的服务以第2条确认的需求文件为准。'), t);
});

check('不带入未被引用的条款（第6条）与序言', () => {
  const r = buildExcerpt(text, [3]);
  assert.ok(r.ok);
  const t = r.excerpt!.text;
  assert.ok(!t.includes('技术服务合同（无冲突示例）'));
  assert.ok(!t.includes('第六条 争议解决'));
  assert.ok(!t.includes('第四条 验收'));
  assert.ok(!t.includes('第五条 费用'));
});

check('多个起点：合并收齐、去重并按原文顺序排列', () => {
  const r = buildExcerpt(text, [3, 2]);
  assert.ok(r.ok);
  assert.deepEqual(r.excerpt!.reached, [1, 2, 3]);
  // 第1条只出现一次（既是 2 直接引用、又经 3->2->1 传递可达）
  assert.equal(r.excerpt!.text.split('第一条 总则').length - 1, 1);
  // seed 标记：2、3 为勾选起点，1 为递归收齐
  const seedOf = new Map(r.excerpt!.clauses.map((c) => [c.number, c.seed]));
  assert.equal(seedOf.get(2), true);
  assert.equal(seedOf.get(3), true);
  assert.equal(seedOf.get(1), false);
});

check('循环引用 4↔5：只收录一次、不死循环', () => {
  const r = buildExcerpt(text, [4]);
  assert.ok(r.ok);
  assert.deepEqual(r.excerpt!.reached, [4, 5]);
  assert.equal(r.excerpt!.count, 2);
  assert.equal(r.excerpt!.text.split('第四条 验收').length - 1, 1);
  assert.equal(r.excerpt!.text.split('第五条 费用与结算').length - 1, 1);
  // 不扩散到其他条款
  assert.ok(!r.excerpt!.text.includes('第三条'));
});

check('无引用的孤立条款：摘录仅含自身区块', () => {
  const r = buildExcerpt(text, [6]);
  assert.ok(r.ok);
  assert.deepEqual(r.excerpt!.reached, [6]);
  assert.equal(r.excerpt!.text, '第六条 争议解决\n因本合同产生的争议，协商不成的提交仲裁。');
});

check('保留各区块原字句与编号：中文标题、阿拉伯引用均逐字保留', () => {
  const r = buildExcerpt(text, [2]);
  assert.ok(r.ok);
  assert.equal(
    r.excerpt!.text,
    '第一条 总则\n本合同由甲乙双方依据相关法律订立。\n\n' +
      '第二条 定义\n本合同术语的含义适用第1条的解释原则。',
  );
  // clauses 中区块文本逐字一致，引用 token 原样报告
  const c2 = r.excerpt!.clauses.find((c) => c.number === 2)!;
  assert.equal(c2.references.length, 1);
  assert.equal(c2.references[0].text, '第1条');
  assert.equal(c2.references[0].number, 1);
  assert.equal(c2.references[0].pos.line, 7);
});

check('行首带缩进的标题：区块从缩进的行首开始（与裁撤边界口径一致）', () => {
  const t = ['序言内容', '', '  第一条 甲', '内容。', '第二条 乙', '见第1条。'].join('\n');
  const r = buildExcerpt(t, [2]);
  assert.ok(r.ok);
  assert.ok(r.excerpt!.text.startsWith('  第一条 甲\n内容。'), JSON.stringify(r.excerpt!.text));
  assert.ok(!r.excerpt!.text.includes('序言内容'));
});

check('原文末尾换行随末收录区块保留；中间跳过区块不产生额外拼接', () => {
  const t = '第一条 甲\n内容一。\n\n第二条 乙\n内容二。\n\n第三条 丙\n见第1条。\n';
  const r = buildExcerpt(t, [3]);
  assert.ok(r.ok);
  // 第1条区块结尾的空行是其原文的一部分（边界到第三条行首前），整体保留；
  // 第2条整段不在摘录中，不额外补任何字符。
  assert.equal(
    r.excerpt!.text,
    '第一条 甲\n内容一。\n\n第三条 丙\n见第1条。\n',
  );
});

console.log('excerpt conflicts:');
check('空选择 -> EMPTY_SELECTION（normalize 与 build 两处都明确提示）', () => {
  assert.ok(
    normalizeExcerptRequest({ numbers: [] }).errors.some((e) => e.code === 'EMPTY_SELECTION'),
  );
  assert.ok(normalizeExcerptRequest({}).errors.some((e) => e.code === 'EMPTY_SELECTION'));
  const r = buildExcerpt(text, []);
  assert.ok(!r.ok);
  assert.equal(r.conflicts![0].code, 'EMPTY_SELECTION');
  assert.match(r.conflicts![0].message, /至少勾选/);
});

check('编号非正整数 -> INVALID_NUMBER；重复编号去重后保留一次', () => {
  const norm = normalizeExcerptRequest({ numbers: [1, 'x', -3, 2, 1] });
  assert.ok(norm.errors.some((e) => e.code === 'INVALID_NUMBER'));
  assert.deepEqual(norm.numbers, [1, 2]);
});

check('勾选编号没有标题定义（仅被引用） -> SELECTION_NOT_DEFINED', () => {
  const t = ['第一条 甲', '内容。', '第二条 乙', '另见第99条。'].join('\n');
  const r = buildExcerpt(t, [99]);
  assert.ok(!r.ok);
  const c = r.conflicts!.find((x) => x.code === 'SELECTION_NOT_DEFINED');
  assert.ok(c);
  assert.equal(c!.number, 99);
});

check('所选编号重复标题 -> DUPLICATE_DEFINITION，标出冲突编号和每处标题行', () => {
  const t = [
    '第一条 甲',
    '内容。',
    '第二条 乙',
    '另见第1条。',
    '第一条 重复标题',
    '误粘贴。',
  ].join('\n');
  const r = buildExcerpt(t, [2]);
  assert.ok(!r.ok);
  const c = r.conflicts!.find((x) => x.code === 'DUPLICATE_DEFINITION');
  assert.ok(c);
  assert.equal(c!.number, 1);
  assert.deepEqual(c!.positions!.map((p) => p.line), [1, 5]);
  assert.deepEqual(
    c!.headings!.map((h) => h.heading),
    ['第一条 甲', '第一条 重复标题'],
  );
});

check('不可达的重复标题不影响摘录（仅所选/可达编号冲突才拒绝）', () => {
  const t = [
    '第一条 甲',
    '内容。',
    '第二条 乙',
    '内容。',
    '第九条 重复来源',
    '内容。',
    '第九条 重复标题',
    '误粘贴。',
  ].join('\n');
  const r = buildExcerpt(t, [1]);
  assert.ok(r.ok);
  assert.deepEqual(r.excerpt!.reached, [1]);
});

check('起点区块直接引用未定义编号 -> MISSING_DEFINITION 并列出引用位置', () => {
  const t = ['第一条 甲', '另见第99条。'].join('\n');
  const r = buildExcerpt(t, [1]);
  assert.ok(!r.ok);
  const c = r.conflicts!.find((x) => x.code === 'MISSING_DEFINITION');
  assert.ok(c);
  assert.equal(c!.number, 99);
  assert.equal(c!.positions![0].line, 2);
  assert.equal(c!.references![0].ownerNumber, 1);
  assert.ok(c!.references![0].line.includes('另见第99条'));
});

check('传递可达区块引用未定义编号 -> 同样拒绝并给出位置', () => {
  const t = [
    '第一条 甲',
    '见第99条。',
    '第二条 乙',
    '见第1条。',
    '第三条 丙',
    '见第2条。',
  ].join('\n');
  const r = buildExcerpt(t, [3]);
  assert.ok(!r.ok);
  const c = r.conflicts!.find((x) => x.code === 'MISSING_DEFINITION');
  assert.ok(c);
  assert.equal(c!.number, 99);
  assert.equal(c!.positions![0].line, 2);
  assert.equal(c!.references![0].ownerNumber, 1);
});

check('不可达区块内的缺失引用不影响摘录', () => {
  const t = [
    '第一条 甲',
    '内容。',
    '第二条 乙',
    '内容。',
    '第三条 丙',
    '另见第88条。',
  ].join('\n');
  const r = buildExcerpt(t, [1]);
  assert.ok(r.ok);
  assert.deepEqual(r.excerpt!.reached, [1]);
});

check('序言中的未定义引用不算可达，不阻断摘录（序言永不收录）', () => {
  const t = ['鉴于安排见第77条所述。', '', '第一条 甲', '内容。'].join('\n');
  const r = buildExcerpt(t, [1]);
  assert.ok(r.ok);
  assert.equal(r.excerpt!.text, '第一条 甲\n内容。');
});

check('多个未定义编号分别聚合全部引用位置', () => {
  const t = ['第一条 甲', '见第8条与第9条。', '另见第8条一次。'].join('\n');
  const r = buildExcerpt(t, [1]);
  assert.ok(!r.ok);
  const byNum = new Map(r.conflicts!.map((c) => [c.number, c]));
  assert.equal(byNum.get(8)!.positions!.length, 2);
  assert.deepEqual(byNum.get(8)!.positions!.map((p) => p.line), [2, 3]);
  assert.equal(byNum.get(9)!.positions!.length, 1);
});

console.log(`\n摘录测试全部通过：${passed} 项 ✅`);
