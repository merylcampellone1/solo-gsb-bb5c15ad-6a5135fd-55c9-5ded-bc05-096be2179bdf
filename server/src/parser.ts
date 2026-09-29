// 合同文本解析：找出所有“第X条”出现位置，区分“条的定义（标题）”与“引用”，
// 并报告缺失引用与重复编号。
//
// 判定规则（在 README 中向用户说明）：
//   - “第X条”位于行首（允许前导空白），且其后紧跟空白、标点或结束，
//     则视为该条的【定义标题】；
//   - 其余出现（含同一条之后正文中的再次出现）一律视为【引用】。
//   此启发式对常见中文合同排版稳定有效。

import { readClauseNumber, type NumberStyle } from './numerals';

export interface TextPos {
  line: number; // 1-based
  column: number; // 1-based
  offset: number; // 0-based char offset
}

export interface ClauseOccurrence {
  number: number;
  style: NumberStyle;
  /** 完整匹配文本，如 “第10条” / “第十二条” */
  text: string;
  start: number;
  end: number; // 排他
  pos: TextPos;
  kind: 'definition' | 'reference';
}

export type IssueKind = 'duplicate_definition' | 'missing_reference';

export interface Issue {
  kind: IssueKind;
  number: number;
  message: string;
  start: number;
  end: number;
  pos: TextPos;
}

export interface DefinitionDTO {
  number: number;
  heading: string; // 该条所在行（去掉前导空白）
  headingLine: number;
  pos: TextPos;
  occurrenceCount: number;
}

export interface ReferenceDTO {
  number: number;
  pos: TextPos;
  line: string;
  targetDefined: boolean;
}

export interface AnalyzeResult {
  occurrences: ClauseOccurrence[];
  issues: Issue[];
}

export interface AnalyzeDTO {
  totalOccurrences: number;
  definedNumbers: number[];
  definitions: DefinitionDTO[];
  references: ReferenceDTO[];
  issues: Issue[];
}

// “第” + 数字（阿拉伯或中文，含大写/两）+ “条”。
// 数字字符类必须显式列出，避免 [一-龥] 把“条”等相邻字吃入。
export const TOKEN_RE_SOURCE =
  '第([0-9]+|[〇零一二两三四五六七八九十百千万億萬壹贰叁肆伍陆柒捌玖拾佰仟亿]+)条';
const TOKEN_RE = new RegExp(TOKEN_RE_SOURCE, 'g');

// 标题后的合法跟随字符（空串结尾也算）。
const AFTER_HEADING = new Set([
  '',
  ' ',
  '\t',
  '　',
  ':',
  '：',
  '.',
  '。',
  '、',
  '，',
  ',',
  '（',
  '(',
  '【',
  '[',
]);

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function posAt(offset: number, lineStarts: number[]): TextPos {
  // 二分找行
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineStarts[lo] + 1, offset };
}

export function analyzeText(text: string): AnalyzeResult {
  const lineStarts = buildLineStarts(text);
  const occurrences: ClauseOccurrence[] = [];

  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(text)) !== null) {
    const parsed = readClauseNumber(match[1]);
    if (parsed === null) continue;

    const start = match.index;
    const end = start + match[0].length;
    const lineStart = lineStarts[findLine(lineStarts, start)];
    const atLineStart = /^[ \t　]*$/.test(text.slice(lineStart, start));
    const after = text[end] ?? '';
    const kind: ClauseOccurrence['kind'] =
      atLineStart && AFTER_HEADING.has(after) ? 'definition' : 'reference';

    occurrences.push({
      number: parsed.value,
      style: parsed.style,
      text: match[0],
      start,
      end,
      pos: posAt(start, lineStarts),
      kind,
    });
  }

  // 按定义出现顺序编号归属：引用指向它之前最近的同号定义（用于界面展示）。
  const definedNumbers = new Set<number>();
  const seenDefinition = new Map<number, ClauseOccurrence>();
  const issues: Issue[] = [];

  for (const occ of occurrences) {
    if (occ.kind === 'definition') {
      if (seenDefinition.has(occ.number)) {
        const first = seenDefinition.get(occ.number)!;
        issues.push({
          kind: 'duplicate_definition',
          number: occ.number,
          message: `第${occ.text.slice(1, -1)}条 重复定义：首次定义于第 ${first.pos.line} 行，第 ${occ.pos.line} 行再次出现标题`,
          start: occ.start,
          end: occ.end,
          pos: occ.pos,
        });
      } else {
        seenDefinition.set(occ.number, occ);
      }
      definedNumbers.add(occ.number);
    }
  }

  for (const occ of occurrences) {
    if (occ.kind === 'reference' && !definedNumbers.has(occ.number)) {
      issues.push({
        kind: 'missing_reference',
        number: occ.number,
        message: `第${occ.text.slice(1, -1)}条 被引用但未定义（第 ${occ.pos.line} 行）`,
        start: occ.start,
        end: occ.end,
        pos: occ.pos,
      });
    }
  }

  return { occurrences, issues };
}

function findLine(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 内部结果 -> API DTO */
export function toAnalyzeDTO(text: string, result: AnalyzeResult): AnalyzeDTO {
  const lineStarts = buildLineStarts(text);
  const lineText = (offset: number) => {
    const li = findLine(lineStarts, offset);
    const from = lineStarts[li];
    const nl = text.indexOf('\n', from);
    return text.slice(from, nl === -1 ? text.length : nl).replace(/^[ \t　]+/, '');
  };

  const firstDef = new Map<number, ClauseOccurrence>();
  const defCounts = new Map<number, number>();
  for (const occ of result.occurrences) {
    if (occ.kind === 'definition') {
      defCounts.set(occ.number, (defCounts.get(occ.number) ?? 0) + 1);
      if (!firstDef.has(occ.number)) firstDef.set(occ.number, occ);
    }
  }

  const definitions: DefinitionDTO[] = [];
  for (const [number, occ] of firstDef) {
    definitions.push({
      number,
      heading: lineText(occ.start),
      headingLine: occ.pos.line,
      pos: occ.pos,
      occurrenceCount: result.occurrences.filter(
        (o) => o.number === number && o.kind === 'reference',
      ).length + (defCounts.get(number) ?? 1),
    });
  }
  definitions.sort((a, b) => a.number - b.number);

  const references: ReferenceDTO[] = result.occurrences
    .filter((o) => o.kind === 'reference')
    .map((o) => ({
      number: o.number,
      pos: o.pos,
      line: lineText(o.start),
      targetDefined: firstDef.has(o.number),
    }))
    .sort((a, b) => a.pos.offset - b.pos.offset);

  return {
    totalOccurrences: result.occurrences.length,
    definedNumbers: [...firstDef.keys()].sort((a, b) => a - b),
    definitions,
    references,
    issues: result.issues.sort((a, b) => a.start - b.start),
  };
}
