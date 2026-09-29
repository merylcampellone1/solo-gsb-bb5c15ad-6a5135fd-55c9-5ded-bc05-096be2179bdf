// 条款摘录引擎（只读）。
//
// 在已保存合同中勾选一个或多个条款作为摘录起点，沿所选条款正文中的
// “第X条”引用递归收齐被引用条款：
//   - 区块边界完全复用 parser / removal 的标题边界口径：区块 = 行首“第X条”
//     标题行行首到下一条标题行行首（不含），末条延伸至文末；首个标题之前
//     为“序言”，永远不会进入摘录；
//   - 只沿“已定义且唯一”的条款追踪：从勾选集合出发 BFS，沿区块内引用展开，
//     已访问编号不再入队（循环引用只收录一次，天然不会死循环）；
//   - 结果区块按【原文顺序】拼接，逐字保留各区块标题行与正文（含原有编号、
//     空白、标点），不带入未被引用的条款及序言。
//
// 以下情形拒绝生成（不修改文档、不写撤销历史）：
//   - 空选择 / 编号非正整数；
//   - 勾选编号在正文中没有标题定义（引用不能作为摘录起点）；
//   - 所选或可达编号存在重复标题：区块边界不唯一，附冲突编号与每处标题行；
//   - 可达区块内的引用指向未定义编号：附全部引用位置。
// 未被选、也不可达的重复标题 / 缺失引用不影响本次摘录，不参与拒绝判定。

import { analyzeText, type ClauseOccurrence, type TextPos } from './parser';

// ---------- 请求规范化 ----------

export type ExcerptConflictCode =
  | 'EMPTY_SELECTION'
  | 'INVALID_NUMBER'
  | 'SELECTION_NOT_DEFINED'
  | 'DUPLICATE_DEFINITION'
  | 'MISSING_DEFINITION';

export interface ExcerptConflict {
  code: ExcerptConflictCode;
  message: string;
  /** 冲突编号（重复标题 / 未定义编号 / 未定义的勾选编号） */
  number?: number;
  positions?: TextPos[];
  /** DUPLICATE_DEFINITION：同编号的每处标题（编号 + 标题行文本 + 位置） */
  headings?: { number: number; heading: string; pos: TextPos }[];
  /** MISSING_DEFINITION：每处未定义引用（引用位置、所在行、所在条款） */
  references?: { number: number; pos: TextPos; line: string; ownerNumber: number }[];
}

function positiveInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^[0-9]+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/**
 * 解析请求体 { numbers: number[] }。仅做输入形态校验；
 * 语义校验（是否已定义 / 重复 / 缺失）在 buildExcerpt 中完成。
 */
export function normalizeExcerptRequest(raw: { numbers?: unknown }): {
  numbers: number[];
  errors: ExcerptConflict[];
} {
  const errors: ExcerptConflict[] = [];
  const numbers: number[] = [];

  const rawNumbers = Array.isArray(raw.numbers) ? raw.numbers : null;
  if (rawNumbers === null || rawNumbers.length === 0) {
    errors.push({
      code: 'EMPTY_SELECTION',
      message: '请至少勾选一个条款作为摘录起点。',
    });
  } else {
    const seen = new Set<number>();
    rawNumbers.forEach((v, idx) => {
      const n = positiveInt(v);
      if (n === null) {
        errors.push({
          code: 'INVALID_NUMBER',
          message: `摘录编号列表第 ${idx + 1} 项不是正整数：${JSON.stringify(v)}。`,
        });
      } else if (!seen.has(n)) {
        seen.add(n);
        numbers.push(n);
      }
    });
  }

  return { numbers, errors };
}

// ---------- 文本结构（与 removal.buildGraph 同一边界口径） ----------

interface Section {
  number: number;
  /** 标题 token 出现 */
  occ: ClauseOccurrence;
  /** 标题行行首偏移（含前导空白） */
  lineStart: number;
  /** 区块结束偏移（排他）：下一条标题行首或文末 */
  end: number;
  /** 标题行去前导空白文本 */
  heading: string;
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function posAtOffset(lineStarts: number[], offset: number): TextPos {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineStarts[lo] + 1, offset };
}

function lineTextOf(text: string, lineStarts: number[], offset: number): string {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  const from = lineStarts[lo];
  const nl = text.indexOf('\n', from);
  return text.slice(from, nl === -1 ? text.length : nl).replace(/^[ \t　]+/, '');
}

// ---------- 结果 DTO ----------

export interface ExcerptRefDTO {
  /** 被引用编号 */
  number: number;
  /** 完整 token，如 “第10条” / “第十二条” */
  text: string;
  pos: TextPos;
  /** 引用所在行（去前导空白） */
  line: string;
}

export interface ExcerptClauseDTO {
  number: number;
  heading: string;
  headingLine: number;
  /** 区块起始行（标题行，含前导空白） */
  startLine: number;
  /** 区块结束行（1-based） */
  endLine: number;
  /** 是否为用户勾选的摘录起点（false 表示沿引用递归收齐） */
  seed: boolean;
  /** 区块原文（标题行 + 正文，逐字保留，含区块结尾前的空白） */
  text: string;
  /** 区块正文中的全部“第X条”引用（含定义自身同号再次出现） */
  references: ExcerptRefDTO[];
}

export interface ExcerptResult {
  /** 用户勾选的起点编号（去重、升序） */
  selected: number[];
  /** 实际收录编号（起点 + 递归可达），按原文顺序 */
  reached: number[];
  clauses: ExcerptClauseDTO[];
  /** 可复制的纯文本摘录：各区块原文按原文顺序拼接 */
  text: string;
  count: number;
}

export interface BuildExcerptResult {
  ok: boolean;
  excerpt?: ExcerptResult;
  conflicts?: ExcerptConflict[];
}

interface BlockRef {
  occ: ClauseOccurrence;
  owner: number;
}

/**
 * 校验并生成摘录（纯函数，不做任何写入）。
 */
export function buildExcerpt(text: string, selectedInput: number[]): BuildExcerptResult {
  const selected = [...new Set(selectedInput)].sort((a, b) => a - b);
  if (selected.length === 0) {
    return {
      ok: false,
      conflicts: [{ code: 'EMPTY_SELECTION', message: '请至少勾选一个条款作为摘录起点。' }],
    };
  }

  const lineStarts = lineStartsOf(text);
  const { occurrences } = analyzeText(text);

  // 按标题边界切区块（与 removal.buildGraph 一致），保留同编号的多个标题。
  const headings = occurrences
    .filter((o) => o.kind === 'definition')
    .sort((a, b) => a.start - b.start);

  const sections: Section[] = headings.map((occ, i) => ({
    number: occ.number,
    occ,
    lineStart: lineStarts[occ.pos.line - 1],
    end: i + 1 < headings.length ? lineStarts[headings[i + 1].pos.line - 1] : text.length,
    heading: lineTextOf(text, lineStarts, occ.start),
  }));

  // 同编号分组：第一处为“规范区块”（与 parser 定义归属、removal.defined 口径一致）。
  const groups = new Map<number, Section[]>();
  for (const s of sections) {
    const list = groups.get(s.number) ?? [];
    list.push(s);
    groups.set(s.number, list);
  }
  const canonical = new Map<number, Section>();
  for (const [number, list] of groups) canonical.set(number, list[0]);

  // 引用归属：落在哪个区块（序言 owner=null）；只接受位于规范区块内的引用，
  // 重复标题的额外区块本身边界不唯一，其中引用不参与递归（重复冲突仍会整体拒绝）。
  const ownerOf = (offset: number): Section | null => {
    let lo = 0;
    let hi = sections.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sections[mid].lineStart <= offset) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found === -1 || offset >= sections[found].end) return null;
    const s = sections[found];
    return groups.get(s.number)![0] === s ? s : null;
  };

  // 规范区块内引用：边 owner -> 已定义目标；同时登记区块内的缺失引用。
  const edges = new Map<number, Set<number>>();
  const blockRefs = new Map<number, BlockRef[]>();
  for (const occ of occurrences) {
    if (occ.kind !== 'reference') continue;
    const owner = ownerOf(occ.start);
    if (!owner) continue; // 序言、或位于重复标题的额外区块
    const list = blockRefs.get(owner.number) ?? [];
    list.push({ occ, owner: owner.number });
    blockRefs.set(owner.number, list);
    if (canonical.has(occ.number)) {
      let set = edges.get(owner.number);
      if (!set) {
        set = new Set<number>();
        edges.set(owner.number, set);
      }
      set.add(occ.number);
    }
  }

  const conflicts: ExcerptConflict[] = [];

  // 规则 1：勾选编号必须有标题定义（引用不能作为摘录起点）。
  const seeds: number[] = [];
  for (const n of selected) {
    if (!canonical.has(n)) {
      conflicts.push({
        code: 'SELECTION_NOT_DEFINED',
        message: `第${n}条 在当前正文中没有标题定义，不能作为摘录起点（请勾选条款标题，而非正文引用）。`,
        number: n,
      });
    } else {
      seeds.push(n);
    }
  }
  if (conflicts.length > 0) return { ok: false, conflicts };

  // 规则 2：从起点沿引用 BFS 收齐可达编号；visited 去重保证循环引用只收录一次。
  const seedSet = new Set(seeds);
  const reachedSet = new Set<number>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const n = queue.shift()!;
    if (reachedSet.has(n)) continue;
    reachedSet.add(n);
    for (const next of edges.get(n) ?? []) {
      if (!reachedSet.has(next)) queue.push(next);
    }
  }

  // 规则 3：所选或可达编号存在重复标题 → 拒绝并标出冲突编号与每处标题行。
  for (const n of [...reachedSet].sort((a, b) => a - b)) {
    const list = groups.get(n) ?? [];
    if (list.length > 1) {
      conflicts.push({
        code: 'DUPLICATE_DEFINITION',
        message: `第${n}条 存在 ${list.length} 处标题定义（第 ${list
          .map((s) => s.occ.pos.line)
          .join('、')} 行），摘录区块边界不唯一，请先处理重复标题。`,
        number: n,
        positions: list.map((s) => s.occ.pos),
        headings: list.map((s) => ({ number: n, heading: s.heading, pos: s.occ.pos })),
      });
    }
  }

  // 规则 4：可达区块内引用指向未定义编号 → 拒绝并列出全部引用位置。
  const missingByNumber = new Map<number, BlockRef[]>();
  for (const n of reachedSet) {
    for (const r of blockRefs.get(n) ?? []) {
      if (!canonical.has(r.occ.number)) {
        const list = missingByNumber.get(r.occ.number) ?? [];
        list.push(r);
        missingByNumber.set(r.occ.number, list);
      }
    }
  }
  for (const [number, refs] of [...missingByNumber].sort((a, b) => a[0] - b[0])) {
    refs.sort((a, b) => a.occ.start - b.occ.start);
    conflicts.push({
      code: 'MISSING_DEFINITION',
      message: `第${number}条 被引用但未定义（第 ${refs
        .map((r) => r.occ.pos.line)
        .join('、')} 行），无法收齐该引用，请先补齐定义或改号后再摘录。`,
      number,
      positions: refs.map((r) => r.occ.pos),
      references: refs.map((r) => ({
        number,
        pos: r.occ.pos,
        line: lineTextOf(text, lineStarts, r.occ.start),
        ownerNumber: r.owner,
      })),
    });
  }

  if (conflicts.length > 0) return { ok: false, conflicts };

  // ---------- 通过校验：按原文顺序拼接收录区块 ----------
  const includedSections = sections.filter(
    (s) => reachedSet.has(s.number) && groups.get(s.number)![0] === s,
  );
  const clauses: ExcerptClauseDTO[] = [];
  const parts: string[] = [];
  for (const s of includedSections) {
    const blockText = text.slice(s.lineStart, s.end);
    parts.push(blockText);
    const refs = (blockRefs.get(s.number) ?? [])
      .slice()
      .sort((a, b) => a.occ.start - b.occ.start);
    clauses.push({
      number: s.number,
      heading: s.heading,
      headingLine: s.occ.pos.line,
      startLine: s.occ.pos.line,
      endLine: posAtOffset(lineStarts, Math.max(s.lineStart, s.end - 1)).line,
      seed: seedSet.has(s.number),
      text: blockText,
      references: refs.map((r) => ({
        number: r.occ.number,
        text: r.occ.text,
        pos: r.occ.pos,
        line: lineTextOf(text, lineStarts, r.occ.start),
      })),
    });
  }

  // 末尾空白收敛：最后一个收录区块若不在文末，其与下一条（未收录）条款之间
  // 的空行属于区块边界间隙而非条款内容，裁掉；若末收录区块即全文末条且原文
  // 以换行结尾，则保留一个换行（与裁撤引擎的文末处理口径一致）。
  const lastIncluded = includedSections[includedSections.length - 1];
  const endsAtEof = lastIncluded !== undefined && lastIncluded.end === text.length;
  let excerptText = parts.join('').replace(/[ \t\r\n]+$/, '');
  if (endsAtEof && /\n\s*$/.test(text)) excerptText += '\n';

  return {
    ok: true,
    excerpt: {
      selected,
      reached: clauses.map((c) => c.number),
      clauses,
      text: excerptText,
      count: clauses.length,
    },
  };
}
