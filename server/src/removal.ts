// 条款裁撤引擎。
//
// 基于 parser 已识别的“第X条”标题（行首定义）按标题边界切出条款区块：
//   - 区块 = 从某标题行首到下一个标题行首（不含）之间的全部文本，末条延伸到文末；
//   - 文首（第一个标题之前）为“序言”，永不裁撤。
//
// 在区块之上构建【条款引用图】：每条引用归属其所在区块（序言中的引用 owner=null），
// 边 owner -> 被引编号。由此：
//   1) 直接引用待删条款且自身不在删除区块内的位置（含序言）必须逐组映射到未删除条款；
//   2) 沿引用链反向可达待删条款的幸存条款为“传递受影响”，DFS 枚举简单路径，
//      on-path 去重保证循环引用不会死循环；
//   3) 删除区块内部（含区块之间互相引用）随区块整体移除，无需映射。
//
// 重建文本时按原文偏移合并删除区间、在保留区间内单遍替换引用 token，
// 与 renumber 引擎同样保持各自原有数字风格。任何冲突均在写入前拒绝。

import { analyzeText, type ClauseOccurrence, type TextPos } from './parser';
import { renderClauseNumber } from './numerals';

// ---------- 请求规范化 ----------

export interface RemovalReplacement {
  from: number;
  to: number;
}

export type RemovalConflictCode =
  | 'EMPTY_SELECTION'
  | 'INVALID_NUMBER'
  | 'DELETE_NOT_DEFINED'
  | 'DUP_REPLACE_SOURCE'
  | 'UNNEEDED_REPLACEMENT'
  | 'REPLACEMENT_UNDEFINED'
  | 'REPLACEMENT_DELETED'
  | 'UNRESOLVED_REFERENCE'
  | 'DUPLICATE_DEFINITION'
  | 'MISSING_DEFINITION';

export interface RemovalConflict {
  code: RemovalConflictCode;
  message: string;
  from?: number;
  to?: number;
  positions?: TextPos[];
}

function positiveInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^[0-9]+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/**
 * 解析请求体 { deletes: number[], replacements: [{from,to}] }。
 * 仅做输入形态校验；语义校验在 buildRemovalPlan 中完成。
 */
export function normalizeRemovalRequest(raw: {
  deletes?: unknown;
  replacements?: unknown;
}): {
  deletes: number[];
  replacements: RemovalReplacement[];
  errors: RemovalConflict[];
} {
  const errors: RemovalConflict[] = [];
  const deletes: number[] = [];
  const replacements: RemovalReplacement[] = [];

  const rawDeletes = Array.isArray(raw.deletes) ? raw.deletes : null;
  if (rawDeletes === null || rawDeletes.length === 0) {
    errors.push({
      code: 'EMPTY_SELECTION',
      message: '请至少勾选一个待裁撤条款。',
    });
  } else {
    const seen = new Set<number>();
    rawDeletes.forEach((v, idx) => {
      const n = positiveInt(v);
      if (n === null) {
        errors.push({
          code: 'INVALID_NUMBER',
          message: `裁撤列表第 ${idx + 1} 项不是正整数：${JSON.stringify(v)}。`,
        });
      } else if (!seen.has(n)) {
        seen.add(n);
        deletes.push(n);
      }
    });
  }

  const rawRows = Array.isArray(raw.replacements) ? raw.replacements : [];
  const rowSeen = new Set<number>();
  rawRows.forEach((row, idx) => {
    if (row === null || typeof row !== 'object') {
      errors.push({
        code: 'INVALID_NUMBER',
        message: `替代映射第 ${idx + 1} 行格式无效。`,
      });
      return;
    }
    const from = positiveInt((row as { from?: unknown }).from);
    const to = positiveInt((row as { to?: unknown }).to);
    if (from === null || to === null) {
      errors.push({
        code: 'INVALID_NUMBER',
        message: `替代映射第 ${idx + 1} 行：旧、新编号都必须是正整数。`,
      });
      return;
    }
    if (rowSeen.has(from)) {
      errors.push({
        code: 'DUP_REPLACE_SOURCE',
        message: `待删条款 ${from} 出现了多个替代目标，一个编号只能映射一个幸存条款。`,
        from,
        positions: [],
      });
      return;
    }
    rowSeen.add(from);
    replacements.push({ from, to });
  });

  return { deletes, replacements, errors };
}

// ---------- 文本结构 ----------

export interface Section {
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

interface RefAt {
  occ: ClauseOccurrence;
  /** 所在条款编号；序言（首标题之前）为 null */
  owner: number | null;
}

export interface ClauseGraph {
  sections: Section[];
  defined: Map<number, Section>;
  definedNumbers: Set<number>;
  /** 全部引用（含指向未定义编号的引用） */
  refs: RefAt[];
  /** owner 编号 -> 其区块内引用过的、已定义的目标编号（去重） */
  edges: Map<number, Set<number>>;
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function posAtOffset(text: string, offset: number, lineStarts: number[]): TextPos {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineStarts[lo] + 1, offset };
}

function headingLineOf(text: string, lineStarts: number[], offset: number): string {
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

/** 按标题边界切分条款区块并构建引用图。 */
export function buildGraph(text: string): ClauseGraph {
  const { occurrences } = analyzeText(text);
  const lineStarts = lineStartsOf(text);

  const headings = occurrences
    .filter((o) => o.kind === 'definition')
    .sort((a, b) => a.start - b.start);

  const sections: Section[] = headings.map((occ, i) => ({
    number: occ.number,
    occ,
    lineStart: lineStarts[occ.pos.line - 1],
    end: i + 1 < headings.length ? lineStarts[headings[i + 1].pos.line - 1] : text.length,
    heading: headingLineOf(text, lineStarts, occ.start),
  }));

  const defined = new Map<number, Section>();
  for (const s of sections) {
    if (!defined.has(s.number)) defined.set(s.number, s);
  }

  const ownerOf = (offset: number): number | null => {
    // 二分找到最后一个 lineStart <= offset 的区块
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
    return sections[found].number;
  };

  const refs: RefAt[] = occurrences
    .filter((o) => o.kind === 'reference')
    .map((occ) => ({ occ, owner: ownerOf(occ.start) }));

  const edges = new Map<number, Set<number>>();
  for (const r of refs) {
    if (r.owner === null || !defined.has(r.occ.number)) continue;
    let set = edges.get(r.owner);
    if (!set) {
      set = new Set<number>();
      edges.set(r.owner, set);
    }
    set.add(r.occ.number);
  }

  return {
    sections,
    defined,
    definedNumbers: new Set(defined.keys()),
    refs,
    edges,
  };
}

// ---------- 影响分析 ----------

export interface DirectRefDTO {
  /** 被引用的待删编号 */
  number: number;
  pos: TextPos;
  line: string;
  /** 引用所在条款；序言为 null */
  ownerNumber: number | null;
  ownerHeading: string | null;
  /** 当前已给的替代目标（预览入参回显用） */
  replacement?: number;
}

export interface ImpactedClauseDTO {
  number: number;
  heading: string;
  headingLine: number;
  /** 是否存在一条直边指向待删集合 */
  direct: boolean;
  /** 从本条款出发到待删编号的引用链，如 [3,2,1] 表示 第3条→第2条→第1条 */
  paths: number[][];
  /** 区块内直接指向待删条款的引用位置 */
  directRefs: { number: number; pos: TextPos }[];
}

export interface DeletedClauseDTO {
  number: number;
  heading: string;
  headingLine: number;
  /** 幸存正文中指向该编号、必须映射的引用数量 */
  survivingRefCount: number;
  /** 是否无任何引用（含删除区块内部），可直接裁撤 */
  unreferenced: boolean;
}

export interface RemovalImpact {
  deletes: DeletedClauseDTO[];
  directReferences: DirectRefDTO[];
  impacted: ImpactedClauseDTO[];
  /** 没有任何幸存引用、可直接裁撤的待删编号 */
  unreferenced: number[];
}

const MAX_PATHS = 8;

/**
 * 枚举 start 到 targets 的简单路径；on-path 去重，循环引用安全且不会爆量。
 */
function findPaths(
  edges: Map<number, Set<number>>,
  start: number,
  targets: Set<number>,
): number[][] {
  const paths: number[][] = [];
  // 迭代式 DFS：只有走过至少一条边后命中 targets 才算一条路径，
  // 因此“直接引用”（长度 2）与“传递影响”（长度 ≥3）都能被枚举。
  const stack: { node: number; path: number[] }[] = [{ node: start, path: [start] }];
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    if (paths.length >= MAX_PATHS) break;
    for (const next of edges.get(node) ?? []) {
      if (path.includes(next)) continue; // 回到链上节点即闭环，剪枝
      const nextPath = [...path, next];
      if (targets.has(next)) {
        paths.push(nextPath);
        if (paths.length >= MAX_PATHS) break;
      } else {
        stack.push({ node: next, path: nextPath });
      }
    }
  }
  // 短路径优先、同长度按编号，输出稳定
  paths.sort((a, b) => a.length - b.length || a.join(',').localeCompare(b.join(',')));
  return paths;
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

/**
 * 影响分析（只读）：列出必须处理的直接引用与沿引用链传递受影响的幸存条款。
 * 调用方应保证 deletes 均已定义；未定义编号会被忽略。
 */
export function analyzeRemoval(text: string, deleteNumbers: number[]): RemovalImpact {
  const graph = buildGraph(text);
  const lineStarts = lineStartsOf(text);
  const deleteSet = new Set(deleteNumbers.filter((n) => graph.defined.has(n)));

  // 幸存侧（含序言）指向待删条款的引用
  const surviving: RefAt[] = graph.refs.filter(
    (r) =>
      deleteSet.has(r.occ.number) &&
      (r.owner === null || !deleteSet.has(r.owner)),
  );
  surviving.sort((a, b) => a.occ.start - b.occ.start);

  const byTarget = new Map<number, RefAt[]>();
  for (const r of surviving) {
    const list = byTarget.get(r.occ.number) ?? [];
    list.push(r);
    byTarget.set(r.occ.number, list);
  }
  const directReferences: DirectRefDTO[] = surviving.map((r) => ({
    number: r.occ.number,
    pos: r.occ.pos,
    line: lineTextOf(text, lineStarts, r.occ.start),
    ownerNumber: r.owner,
    ownerHeading: r.owner === null ? null : graph.defined.get(r.owner)?.heading ?? null,
  }));

  // 传递影响：幸存条款沿引用链可达任一待删条款
  const impacted: ImpactedClauseDTO[] = [];
  for (const section of graph.sections) {
    if (deleteSet.has(section.number)) continue;
    // 重复标题的同编号区块只报告一次
    if (impacted.some((x) => x.number === section.number)) continue;
    const paths = findPaths(graph.edges, section.number, deleteSet);
    if (paths.length === 0) continue;
    const directRefs = graph.refs
      .filter(
        (r) =>
          r.owner === section.number &&
          r.occ.kind === 'reference' &&
          deleteSet.has(r.occ.number),
      )
      .map((r) => ({ number: r.occ.number, pos: r.occ.pos }))
      .sort((a, b) => a.pos.offset - b.pos.offset);
    impacted.push({
      number: section.number,
      heading: section.heading,
      headingLine: section.occ.pos.line,
      direct: directRefs.length > 0,
      paths,
      directRefs,
    });
  }
  impacted.sort((a, b) => a.number - b.number);

  const referencedAnywhere = new Set<number>();
  for (const r of graph.refs) referencedAnywhere.add(r.occ.number);

  const deletes: DeletedClauseDTO[] = [];
  const unreferenced: number[] = [];
  for (const n of [...deleteSet].sort((a, b) => a - b)) {
    const survivingRefCount = byTarget.get(n)?.length ?? 0;
    const noRef = !referencedAnywhere.has(n);
    deletes.push({
      number: n,
      heading: graph.defined.get(n)!.heading,
      headingLine: graph.defined.get(n)!.occ.pos.line,
      survivingRefCount,
      unreferenced: noRef,
    });
    if (noRef) unreferenced.push(n);
  }

  return { deletes, directReferences, impacted, unreferenced };
}

// ---------- 删除计划 ----------

export interface NeighborHeadingDTO {
  number: number;
  heading: string;
  headingLine: number;
}

export interface RemovalBlock {
  number: number;
  heading: string;
  /** 标题行行首（区块起点）位置，列号恒为 1 */
  start: TextPos;
  /** 区块结束（排他）位置 */
  end: TextPos;
  startLine: number;
  endLine: number;
  /** 将被删除的完整文本 */
  removedText: string;
  prev: NeighborHeadingDTO | null;
  next: NeighborHeadingDTO | null;
}

export interface RemovalChangeItem {
  kind: 'reference';
  fromNumber: number;
  toNumber: number;
  before: string;
  after: string;
  line: number;
  column: number;
  snippet: string;
  /** 引用所在条款；序言为 null */
  ownerNumber: number | null;
}

export interface BuildRemovalResult {
  ok: boolean;
  blocks?: RemovalBlock[];
  changes?: RemovalChangeItem[];
  newText?: string;
  deleteCount?: number;
  conflicts?: RemovalConflict[];
}

function snippetAround(text: string, start: number, end: number): string {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = text.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = text.length;
  const s = text.slice(lineStart, lineEnd).trim();
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}

/**
 * 校验并生成完整裁撤计划（删除区块 + 逐处引用替换），不做任何写入。
 */
export function buildRemovalPlan(
  text: string,
  deleteNumbersInput: number[],
  replacementsInput: RemovalReplacement[],
): BuildRemovalResult {
  const conflicts: RemovalConflict[] = [];
  const lineStarts = lineStartsOf(text);
  const { occurrences } = analyzeText(text);
  const graph = buildGraph(text);

  // 规则 0：空选择
  const deleteNumbers = [...new Set(deleteNumbersInput)].sort((a, b) => a - b);
  if (deleteNumbers.length === 0) {
    return {
      ok: false,
      conflicts: [
        { code: 'EMPTY_SELECTION', message: '请至少勾选一个待裁撤条款。' },
      ],
    };
  }
  const deleteSet = new Set(deleteNumbers);

  // 规则 1：文本存在重复定义 → 标题边界与引用归属不唯一，整体拒绝。
  const defsByNumber = new Map<number, ClauseOccurrence[]>();
  for (const occ of occurrences) {
    if (occ.kind !== 'definition') continue;
    const list = defsByNumber.get(occ.number) ?? [];
    list.push(occ);
    defsByNumber.set(occ.number, list);
  }
  for (const [number, defs] of defsByNumber) {
    if (defs.length > 1) {
      conflicts.push({
        code: 'DUPLICATE_DEFINITION',
        message: `第${number}条 存在 ${defs.length} 处标题定义（第 ${defs
          .map((d) => d.pos.line)
          .join('、')} 行），无法确定唯一裁撤边界，请先处理重复定义。`,
        from: number,
        positions: defs.map((d) => d.pos),
      });
    }
  }

  // 规则 2：文本存在指向未定义编号的引用（“缺失定义”）→ 拒绝并给出全部位置。
  const missingByNumber = new Map<number, TextPos[]>();
  for (const occ of occurrences) {
    if (occ.kind === 'reference' && !graph.defined.has(occ.number)) {
      const list = missingByNumber.get(occ.number) ?? [];
      list.push(occ.pos);
      missingByNumber.set(occ.number, list);
    }
  }
  for (const [number, positions] of missingByNumber) {
    conflicts.push({
      code: 'MISSING_DEFINITION',
      message: `第${number}条 被引用但未定义（第 ${positions
        .map((p) => p.line)
        .join('、')} 行），引用图不完整，请先补齐或改号后再裁撤。`,
      from: number,
      positions,
    });
  }

  // 规则 3：待删编号必须有标题定义。
  for (const n of deleteNumbers) {
    if (!graph.defined.has(n)) {
      conflicts.push({
        code: 'DELETE_NOT_DEFINED',
        message: `第${n}条 在文本中没有标题定义，无法裁撤。`,
        from: n,
      });
    }
  }

  const replacementMap = new Map<number, number>();
  for (const r of replacementsInput) {
    // 规则 4：替代源必须是待删编号（且已定义）。
    if (!deleteSet.has(r.from)) {
      conflicts.push({
        code: 'UNNEEDED_REPLACEMENT',
        message:
          r.from === r.to
            ? `第${r.from}条 不在裁撤集合内，无需替代映射。`
            : `第${r.from}条 不在裁撤集合内，不能把它的引用改指向第${r.to}条；如需改号请使用重编号流程。`,
        from: r.from,
        to: r.to,
        positions: graph.defined.has(r.from) ? [graph.defined.get(r.from)!.occ.pos] : [],
      });
      continue;
    }
    // 规则 5：替代目标必须是未删除的既有条款。
    if (!graph.defined.has(r.to)) {
      conflicts.push({
        code: 'REPLACEMENT_UNDEFINED',
        message: `第${r.from}条 的替代目标第${r.to}条在文本中没有定义，必须映射到一个已定义条款。`,
        from: r.from,
        to: r.to,
      });
      continue;
    }
    if (deleteSet.has(r.to)) {
      conflicts.push({
        code: 'REPLACEMENT_DELETED',
        message: `不能把第${r.from}条的引用指向第${r.to}条：第${r.to}条也在本次裁撤集合中。`,
        from: r.from,
        to: r.to,
        positions: [graph.defined.get(r.to)!.occ.pos],
      });
      continue;
    }
    replacementMap.set(r.from, r.to);
  }

  // 幸存侧引用：未映射 → 未处理引用冲突（按待删编号聚合位置）。
  const surviving = graph.refs
    .filter(
      (r) =>
        deleteSet.has(r.occ.number) &&
        (r.owner === null || !deleteSet.has(r.owner)),
    )
    .sort((a, b) => a.occ.start - b.occ.start);

  const survivingByTarget = new Map<number, RefAt[]>();
  for (const r of surviving) {
    const list = survivingByTarget.get(r.occ.number) ?? [];
    list.push(r);
    survivingByTarget.set(r.occ.number, list);
  }
  for (const n of deleteNumbers) {
    if (survivingByTarget.has(n) && !replacementMap.has(n)) {
      const refs = survivingByTarget.get(n)!;
      conflicts.push({
        code: 'UNRESOLVED_REFERENCE',
        message: `第${n}条 将被裁撤，但幸存正文中仍有 ${refs.length} 处引用（第 ${refs
          .map((r) => r.occ.pos.line)
          .join('、')} 行）未指定替代条款。`,
        from: n,
        positions: refs.map((r) => r.occ.pos),
      });
    }
  }

  // 规则 6：给了替代映射、但幸存侧并无引用 → 多余映射，拒绝。
  for (const [from] of replacementMap) {
    if (!survivingByTarget.has(from)) {
      conflicts.push({
        code: 'UNNEEDED_REPLACEMENT',
        message: `第${from}条 在保留文本中没有需要改写的引用（引用均位于待删区块内），无需替代映射。`,
        from,
        to: replacementMap.get(from),
      });
    }
  }

  if (conflicts.length > 0) return { ok: false, conflicts };

  // ---------- 通过校验：计算删除区块 ----------
  const sectionIndex = new Map<number, number>();
  graph.sections.forEach((s, i) => sectionIndex.set(s.number, i));

  const targetIndexes = deleteNumbers
    .map((n) => sectionIndex.get(n)!)
    .sort((a, b) => a - b);
  const ranges = targetIndexes.map((i) => {
    const s = graph.sections[i];
    return { number: s.number, start: s.lineStart, end: s.end };
  });

  const blocks: RemovalBlock[] = targetIndexes.map((i) => {
    const s = graph.sections[i];
    const prevSec = i > 0 ? graph.sections[i - 1] : null;
    const nextSec = i + 1 < graph.sections.length ? graph.sections[i + 1] : null;
    return {
      number: s.number,
      heading: s.heading,
      start: posAtOffset(text, s.lineStart, lineStarts),
      end: posAtOffset(text, s.end, lineStarts),
      startLine: s.occ.pos.line,
      endLine: posAtOffset(text, Math.max(s.lineStart, s.end - 1), lineStarts).line,
      removedText: text.slice(s.lineStart, s.end),
      prev: prevSec && {
        number: prevSec.number,
        heading: prevSec.heading,
        headingLine: prevSec.occ.pos.line,
      },
      next: nextSec && {
        number: nextSec.number,
        heading: nextSec.heading,
        headingLine: nextSec.occ.pos.line,
      },
    };
  });

  // ---------- 单遍重建：删除区间外的引用 token 按映射替换 ----------
  const changes: RemovalChangeItem[] = [];
  const parts: string[] = [];
  let cursor = 0;

  for (const r of ranges) {
    // 段 [cursor, r.start) 为保留文本，替换其中映射到的引用
    for (const occ of occurrences) {
      if (occ.kind !== 'reference' || occ.start < cursor || occ.start >= r.start) continue;
      const to = replacementMap.get(occ.number);
      if (to === undefined) continue;
      parts.push(text.slice(cursor, occ.start));
      const newToken = `第${renderClauseNumber(to, occ.style)}条`;
      parts.push(newToken);
      cursor = occ.end;
      changes.push({
        kind: 'reference',
        fromNumber: occ.number,
        toNumber: to,
        before: occ.text,
        after: newToken,
        line: occ.pos.line,
        column: occ.pos.column,
        snippet: snippetAround(text, occ.start, occ.end),
        ownerNumber: null, // 下面用引用图补
      });
    }
    parts.push(text.slice(cursor, r.start));
    // 跳过整个删除区块
    cursor = r.end;
  }
  // 末段保留文本
  for (const occ of occurrences) {
    if (occ.kind !== 'reference' || occ.start < cursor) continue;
    const to = replacementMap.get(occ.number);
    if (to === undefined) continue;
    parts.push(text.slice(cursor, occ.start));
    const newToken = `第${renderClauseNumber(to, occ.style)}条`;
    parts.push(newToken);
    cursor = occ.end;
    changes.push({
      kind: 'reference',
      fromNumber: occ.number,
      toNumber: to,
      before: occ.text,
      after: newToken,
      line: occ.pos.line,
      column: occ.pos.column,
      snippet: snippetAround(text, occ.start, occ.end),
      ownerNumber: null,
    });
  }
  parts.push(text.slice(cursor));

  // 补上每个替换引用的归属条款
  const ownerByOffset = new Map<number, number | null>();
  for (const ref of graph.refs) ownerByOffset.set(ref.occ.start, ref.owner);
  for (const c of changes) {
    const offset = lineStarts[c.line - 1] + c.column - 1;
    c.ownerNumber = ownerByOffset.get(offset) ?? null;
  }
  changes.sort((a, b) => a.line - b.line || a.column - b.column);

  // 文末空白收敛：末条被删时不遗留多余空行；原文以换行结尾则保留一个换行。
  let newText = parts.join('');
  const endedWithNewline = /\n\s*$/.test(text);
  newText = newText.replace(/[ \t\r\n]+$/, '');
  if (endedWithNewline) newText += '\n';

  return {
    ok: true,
    blocks,
    changes,
    newText,
    deleteCount: blocks.length,
  };
}
