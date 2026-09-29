// 重编号引擎。
//
// 关键设计：不做“字符串查找替换”，而是先重新扫描全文中的“第X条”token，
// 基于完整的“旧编号 -> token 起止位置”集合做一次性重建：
//   1) 交换（1<->2）、环形（1->2->3->1）天然正确，因为每个 token 只按
//      其自身的旧编号查表，且重建结果写入独立缓冲，不重复扫描；
//   2) “第1条”与“第10条”等前缀相近编号不会互相误伤，匹配单位是
//      解析出来的整个 token（带“第/条”定界），而非裸数字前缀；
//   3) 任何冲突都在写入前校验，冲突即整体拒绝，绝不部分写入。

import { analyzeText, type AnalyzeResult, type TextPos } from './parser';
import { renderClauseNumber } from './numerals';

export interface MappingEntry {
  from: number;
  to: number;
}

export interface RawRow {
  from?: unknown;
  to?: unknown;
}

export interface ChangeItem {
  kind: 'definition' | 'reference';
  fromNumber: number;
  toNumber: number;
  before: string;
  after: string;
  line: number;
  column: number;
  snippet: string;
}

export interface BuildPlanResult {
  ok: boolean;
  changes?: ChangeItem[];
  newText?: string;
  conflicts?: ConflictError[];
}

export type ConflictCode =
  | 'EMPTY_MAPPING'
  | 'INVALID_ROW'
  | 'DUP_SOURCE'
  | 'DUP_TARGET'
  | 'SOURCE_NOT_DEFINED'
  | 'TARGET_COLLISION';

export interface ConflictError {
  code: ConflictCode;
  message: string;
  from?: number;
  to?: number;
  positions?: TextPos[];
}

/** 来自客户端的原始行 -> 规范化映射；逐行报告输入层面的错误。 */
export function normalizeMapping(rows: RawRow[]): {
  entries: MappingEntry[];
  errors: ConflictError[];
} {
  const errors: ConflictError[] = [];
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      entries: [],
      errors: [
        { code: 'EMPTY_MAPPING', message: '映射为空：请至少填写一行“旧编号 -> 新编号”。' },
      ],
    };
  }

  const positiveInt = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
    if (typeof v === 'string' && /^[0-9]+$/.test(v.trim())) return Number(v.trim());
    return null;
  };

  const bySource = new Map<number, number>();
  const targetOwners = new Map<number, number>();

  rows.forEach((row, idx) => {
    if (row === null || typeof row !== 'object') {
      errors.push({
        code: 'INVALID_ROW',
        message: `第 ${idx + 1} 行：映射格式无效。`,
      });
      return;
    }
    const from = positiveInt(row.from);
    const to = positiveInt(row.to);
    if (from === null || to === null) {
      errors.push({
        code: 'INVALID_ROW',
        message: `第 ${idx + 1} 行：旧编号与新编号都必须是正整数（收到 ${JSON.stringify(row.from)} -> ${JSON.stringify(row.to)}）。`,
      });
      return;
    }
    if (from === to) return; // 未变化的行直接忽略
    if (bySource.has(from)) {
      errors.push({
        code: 'DUP_SOURCE',
        message: `旧编号 ${from} 在映射中出现多次（第 ${idx + 1} 行），同一编号只能有一个目标。`,
        from,
      });
      return;
    }
    if (targetOwners.has(to)) {
      errors.push({
        code: 'DUP_TARGET',
        message: `新编号 ${to} 被旧编号 ${targetOwners.get(to)} 与 ${from} 同时占用，无法决定归属。`,
        from,
        to,
      });
      return;
    }
    bySource.set(from, to);
    targetOwners.set(to, from);
  });

  const entries = [...bySource].map(([from, to]) => ({ from, to }));
  return { entries, errors };
}

function snippetAround(text: string, start: number, end: number): string {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = text.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = text.length;
  const s = text.slice(lineStart, lineEnd).trim();
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}

/**
 * 依据映射生成完整变更计划。
 * 不修改任何存储；返回全部逐处变更、重建后的新文本，或冲突列表。
 */
export function buildPlan(text: string, entries: MappingEntry[]): BuildPlanResult {
  const map = new Map(entries.map((e) => [e.from, e.to]));
  const { occurrences } = analyzeText(text);

  const definitions = new Set(
    occurrences.filter((o) => o.kind === 'definition').map((o) => o.number),
  );
  const conflicts: ConflictError[] = [];

  // 规则 1：源必须是文本中实际存在的“条”定义。
  for (const { from } of entries) {
    if (!definitions.has(from)) {
      conflicts.push({
        code: 'SOURCE_NOT_DEFINED',
        message: `旧编号 ${from} 在文本中没有对应的“第${from}条”标题定义，无法改号。`,
        from,
      });
    }
  }

  // 规则 2：目标不得撞上“不参与本次改号”的既有编号（会产生重复定义）。
  for (const { from, to } of entries) {
    if (definitions.has(to) && !map.has(to)) {
      const positions = occurrences
        .filter((o) => o.number === to && o.kind === 'definition')
        .map((o) => o.pos);
      conflicts.push({
        code: 'TARGET_COLLISION',
        message: `新编号 ${to} 已被既有条款占用且不在本次映射中：${from} -> ${to} 会与第 ${positions
          .map((p) => p.line)
          .join('、')} 行的“第${to}条”标题重复。`,
        from,
        to,
        positions,
      });
    }
  }

  if (conflicts.length > 0) return { ok: false, conflicts };

  // 通过校验：单遍重建。按位置升序遍历 token，按偏移拼接，每处只处理一次。
  const ordered = [...occurrences].sort((a, b) => a.start - b.start);
  const changes: ChangeItem[] = [];
  const parts: string[] = [];
  let cursor = 0;

  for (const occ of ordered) {
    if (!map.has(occ.number)) {
      continue;
    }
    const newNumber = map.get(occ.number)!;
    const newToken = `第${renderClauseNumber(newNumber, occ.style)}条`;

    parts.push(text.slice(cursor, occ.start), newToken);
    cursor = occ.end;

    changes.push({
      kind: occ.kind,
      fromNumber: occ.number,
      toNumber: newNumber,
      before: occ.text,
      after: newToken,
      line: occ.pos.line,
      column: occ.pos.column,
      snippet: snippetAround(text, occ.start, occ.end),
    });
  }
  parts.push(text.slice(cursor));

  return { ok: true, changes, newText: parts.join('') };
}

/** 供其他模块复用的分析类型 */
export type { AnalyzeResult };
