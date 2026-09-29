// 轻量自检（不依赖测试框架）：覆盖交换、环形、1/10 前缀相近、冲突拒绝、中文数字。
import { analyzeText, toAnalyzeDTO } from '../src/parser';
import { buildPlan, normalizeMapping } from '../src/renumber';
import { parseChineseNumber, toChineseNumber } from '../src/numerals';
import assert from 'node:assert';

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

// ---------- 中文数字 ----------
console.log('numerals:');
check('中文解析：十/十二/二十/一百零一/壹拾贰', () => {
  assert.equal(parseChineseNumber('十'), 10);
  assert.equal(parseChineseNumber('十二'), 12);
  assert.equal(parseChineseNumber('二十'), 20);
  assert.equal(parseChineseNumber('一百零一'), 101);
  assert.equal(parseChineseNumber('壹拾贰'), 12);
  assert.equal(parseChineseNumber('两'), 2);
  assert.equal(parseChineseNumber('十二万三千四百五十六'), 123456);
});
check('中文渲染：1/10/11/101/10001', () => {
  assert.equal(toChineseNumber(1), '一');
  assert.equal(toChineseNumber(10), '十');
  assert.equal(toChineseNumber(11), '十一');
  assert.equal(toChineseNumber(20), '二十');
  assert.equal(toChineseNumber(101), '一百零一');
  assert.equal(toChineseNumber(10001), '一万零一');
});

// ---------- 解析 ----------
const text = [
  '第一条 定义',
  '见第2条和第10条的约定。',
  '第二条 费用',
  '费用按第1条执行，另见第99条。',
  '第10条 附件',
  '附件适用第2条。',
  '第一条 重复标题',
].join('\n');

console.log('parser:');
const dto = toAnalyzeDTO(text, analyzeText(text));
check('识别定义数量（含重复）与引用', () => {
  assert.equal(dto.definitions.length, 3);
  assert.equal(dto.references.length, 5);
});
check('第1条 与 第10条 被区分', () => {
  assert.deepEqual(dto.definedNumbers.sort((a, b) => a - b), [1, 2, 10]);
});
check('检出重复编号', () => {
  const dup = dto.issues.filter((i) => i.kind === 'duplicate_definition');
  assert.equal(dup.length, 1);
  assert.equal(dup[0].number, 1);
});
check('检出缺失引用 第99条', () => {
  const miss = dto.issues.filter((i) => i.kind === 'missing_reference');
  assert.equal(miss.length, 1);
  assert.equal(miss[0].number, 99);
  assert.equal(miss[0].pos.line, 4);
});

// ---------- 交换 ----------
console.log('renumber:');
check('交换 1 <-> 2：标题与引用全部正确', () => {
  const { entries } = normalizeMapping([
    { from: 1, to: 2 },
    { from: 2, to: 1 },
  ]);
  const plan = buildPlan(text, entries);
  assert.ok(plan.ok, '应通过校验');
  const out = plan.newText!;
  assert.ok(out.startsWith('第二条 定义'), out.split('\n')[0]);
  assert.ok(out.includes('见第1条和第10条'), '原第2条引用应变为第1条，第10条不动');
  const line2 = out.split('\n')[1];
  assert.ok(!/第2条/.test(line2), '交换后该行不应再有第2条');
});

check('环形 1->10, 10->2, 2->1', () => {
  const { entries } = normalizeMapping([
    { from: 1, to: 10 },
    { from: 10, to: 2 },
    { from: 2, to: 1 },
  ]);
  const plan = buildPlan(text, entries);
  assert.ok(plan.ok, '环形应被接受');
  const out = plan.newText!;
  const lines = out.split('\n');
  assert.ok(lines[0].startsWith('第十条 定义'), lines[0]);
  assert.ok(lines[2].startsWith('第一条 费用'), lines[2]);
  assert.ok(lines[4].startsWith('第2条 附件'), lines[4]);
  // “见第2条和第10条” 原指向 2、10，环形后分别为 1、2
  assert.ok(lines[1].includes('见第1条和第2条'), lines[1]);
});

// ---------- 冲突 ----------
check('目标撞上未参与映射的既有编号 -> 拒绝且带位置', () => {
  const { entries } = normalizeMapping([{ from: 1, to: 2 }]);
  const plan = buildPlan(text, entries);
  assert.ok(!plan.ok);
  const collision = plan.conflicts!.find((c) => c.code === 'TARGET_COLLISION');
  assert.ok(collision, '应有 TARGET_COLLISION');
  assert.equal(collision!.to, 2);
  assert.ok(collision!.positions!.length > 0, '应携带既有标题位置');
});

check('源不存在 -> SOURCE_NOT_DEFINED', () => {
  const { entries } = normalizeMapping([{ from: 55, to: 3 }]);
  const plan = buildPlan(text, entries);
  assert.ok(!plan.ok);
  assert.ok(plan.conflicts!.some((c) => c.code === 'SOURCE_NOT_DEFINED'));
});

check('映射内目标重复 -> DUP_TARGET', () => {
  const { errors } = normalizeMapping([
    { from: 1, to: 3 },
    { from: 2, to: 3 },
  ]);
  assert.ok(errors.some((e) => e.code === 'DUP_TARGET'));
});

check('非法行 / 空映射', () => {
  assert.ok(normalizeMapping([]).errors.some((e) => e.code === 'EMPTY_MAPPING'));
  assert.ok(
    normalizeMapping([{ from: 'x', to: 2 }]).errors.some((e) => e.code === 'INVALID_ROW'),
  );
});

// ---------- 风格保留 ----------
check('中文标题改号后仍为中文，阿拉伯仍为阿拉伯', () => {
  const t = '第3条 标题\n按第3条处理。';
  const { entries } = normalizeMapping([{ from: 3, to: 12 }]);
  const plan = buildPlan(t, entries);
  assert.ok(plan.ok);
  assert.equal(plan.newText!, '第12条 标题\n按第12条处理。');

  const t2 = '第三条 标题\n按第三条处理。';
  const plan2 = buildPlan(t2, normalizeMapping([{ from: 3, to: 12 }]).entries);
  assert.ok(plan2.ok);
  assert.equal(plan2.newText!, '第十二条 标题\n按第十二条处理。');
});

// ---------- 变更明细 ----------
check('逐处变更同时包含标题与引用，数量正确', () => {
  const { entries } = normalizeMapping([
    { from: 1, to: 2 },
    { from: 2, to: 1 },
  ]);
  const plan = buildPlan(text, entries);
  // 第1条：标题2处（含重复定义）+引用1处；第2条：标题1处+引用2处 = 6
  assert.equal(plan.changes!.length, 6);
  assert.ok(plan.changes!.some((c) => c.kind === 'definition'));
  assert.ok(plan.changes!.some((c) => c.kind === 'reference'));
});

console.log(`\n全部通过：${passed} 项 ✅`);
