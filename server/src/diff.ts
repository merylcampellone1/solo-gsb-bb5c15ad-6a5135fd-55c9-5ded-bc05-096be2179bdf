// 版本对照引擎（只读）。
//
// 以已保存合同为【旧稿】、新粘贴文本为【新稿】，复用 parser 的标题识别
// （行首“第X条”定义）按标题边界切出条款区块，随后分两轮配对：
//
//   1) 规范化：去掉标题中的“第X条”编号、折叠空白（空格/制表/全角空格/换行），
//      得到每条的内容键；
//   2) 内容唯一匹配：内容键在旧、新两侧都恰好出现一次时跨编号配对
//      （编号不同即“仅改号”）；
//   3) 同号配对：对剩余条款，编号在两侧各仅剩一条时直接配对
//      （内容键不同即“内容修改”）；
//   4) 内容重复形成多候选、或同编号存在多条标题时，一律列为【待确认】，
//      绝不擅自归类；最终剩余的单侧条款分别计为新增 / 删除。
//
// 本模块为纯函数：不写库、不修改文档、不触碰撤销历史。

import { analyzeText, type ClauseOccurrence } from './parser';

export type DiffStatus =
  | 'added' // 新增：仅新稿存在
  | 'removed' // 删除：仅旧稿存在
  | 'modified' // 内容修改：配对成功但规范化内容不同
  | 'renumbered' // 仅改号：内容一致但编号变化
  | 'unchanged'; // 无变化：编号与内容均一致

export interface DiffClause {
  number: number;
  /** 文档中的标题顺序（0-based） */
  order: number;
  /** 原始标题行（去前导空白），如 “第十条 费用标准” */
  heading: string;
  /** 标题所在行（1-based） */
  headingLine: number;
  /** 去编号、折叠空白后的条款正文内容键（跨编号匹配依据） */
  contentKey: string;
  /** 区块原文片段（标题 + 正文，截断展示用） */
  snippet: string;
}

export interface DiffPair {
  status: DiffStatus;
  old: DiffClause | null;
  new: DiffClause | null;
}

export type AmbiguousReason = 'duplicate_content' | 'duplicate_number';

export interface AmbiguousGroup {
  reason: AmbiguousReason;
  /** duplicate_number 时的争议编号 */
  number: number | null;
  /** duplicate_content 时的规范化内容键 */
  contentKey: string | null;
  message: string;
  old: DiffClause[];
  new: DiffClause[];
}

export interface DiffIssue {
  kind: 'duplicate_definition' | 'missing_reference';
  number: number;
  message: string;
  line: number;
}

export interface VersionDiff {
  oldClauseCount: number;
  newClauseCount: number;
  pairs: DiffPair[];
  ambiguous: AmbiguousGroup[];
  /** 旧稿解析出的重复定义 / 缺失引用（提示边界可能不唯一） */
  oldIssues: DiffIssue[];
  /** 新稿解析出的重复定义 / 缺失引用，供界面提示 */
  newIssues: DiffIssue[];
  counts: Record<DiffStatus, number> & { ambiguous: number };
}

const SNIPPET_LIMIT = 200;

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function clip(s: string): string {
  const t = s.trim();
  return t.length > SNIPPET_LIMIT ? t.slice(0, SNIPPET_LIMIT - 1) + '…' : t;
}

/**
 * 按现有标题边界拆分条款。
 * 区块 = 标题行行首到下一条标题行行首（不含），末条延伸至文末；
 * 与 removal.buildGraph 的边界口径保持一致，但不丢弃重复编号的标题。
 */
export function splitClauses(text: string): DiffClause[] {
  const { occurrences } = analyzeText(text);
  const lineStarts = lineStartsOf(text);
  const headings = occurrences
    .filter((o) => o.kind === 'definition')
    .sort((a, b) => a.start - b.start);

  return headings.map((occ: ClauseOccurrence, i) => {
    const blockStart = lineStarts[occ.pos.line - 1];
    const blockEnd =
      i + 1 < headings.length ? lineStarts[headings[i + 1].pos.line - 1] : text.length;
    const block = text.slice(blockStart, blockEnd);

    // 标题行原文（去前导空白）
    const nl = text.indexOf('\n', blockStart);
    const heading = text
      .slice(blockStart, nl === -1 ? text.length : nl)
      .replace(/^[ \t　]+/, '');

    // 内容键：标题行去掉“第X条”编号 token、与其余正文一起折叠空白。
    // 标题剩余文字（条标）也参与匹配，正文相同但条标不同的条款不会误配。
    const headingRest = heading.replace(occ.text, '');
    const body = nl === -1 ? '' : text.slice(nl + 1, blockEnd);
    const contentKey = `${headingRest}\n${body}`.replace(/[ \t　\r\n]+/g, ' ').trim();

    return {
      number: occ.number,
      order: i,
      heading,
      headingLine: occ.pos.line,
      contentKey,
      snippet: clip(block),
    };
  });
}

function indexBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

/**
 * 版本对照主流程。纯只读：旧稿/新稿均由入参传入，不触碰任何存储。
 */
export function diffVersions(oldText: string, newText: string): VersionDiff {
  const oldClauses = splitClauses(oldText);
  const newClauses = splitClauses(newText);

  const oldByKey = indexBy(oldClauses, (c) => c.contentKey);
  const newByKey = indexBy(newClauses, (c) => c.contentKey);

  const pairs: DiffPair[] = [];
  const ambiguous: AmbiguousGroup[] = [];
  const oldUsed = new Set<DiffClause>();
  const newUsed = new Set<DiffClause>();

  const statusOf = (o: DiffClause, n: DiffClause): DiffStatus => {
    if (o.contentKey !== n.contentKey) return 'modified';
    return o.number === n.number ? 'unchanged' : 'renumbered';
  };

  // ---------- 第一轮：内容唯一匹配（跨编号） ----------
  // 内容键在两侧都只出现一次 → 唯一配对；任一侧出现多次且两侧均有候选
  // → 多候选歧义，全部挂起为“待确认”，不进入后续配对。
  const allKeys = new Set<string>([...oldByKey.keys(), ...newByKey.keys()]);
  for (const key of allKeys) {
    const olds = oldByKey.get(key) ?? [];
    const news = newByKey.get(key) ?? [];

    if (olds.length === 1 && news.length === 1) {
      const o = olds[0];
      const n = news[0];
      oldUsed.add(o);
      newUsed.add(n);
      pairs.push({ status: statusOf(o, n), old: o, new: n });
      continue;
    }
    if (olds.length > 0 && news.length > 0 && (olds.length > 1 || news.length > 1)) {
      for (const o of olds) oldUsed.add(o);
      for (const n of news) newUsed.add(n);
      ambiguous.push({
        reason: 'duplicate_content',
        number: null,
        contentKey: key,
        message: `相同内容各有 ${olds.length} / ${news.length} 个候选条款，无法唯一配对，请人工确认对应关系。`,
        old: olds,
        new: news,
      });
    }
  }

  // ---------- 第二轮：剩余的唯一同号条款配对 ----------
  const oldLeft = oldClauses.filter((c) => !oldUsed.has(c));
  const newLeft = newClauses.filter((c) => !newUsed.has(c));
  const oldByNum = indexBy(oldLeft, (c) => String(c.number));
  const newByNum = indexBy(newLeft, (c) => String(c.number));

  // 任一稿自身在同编号上剩余多个标题（重复定义）：即便另一稿没有同号候选，
  // 也不把它们自动归类为新增/删除，整组列为“待确认”。
  const suspendOneSide = (
    side: 'old' | 'new',
    byNum: Map<string, DiffClause[]>,
  ): Set<number> => {
    const suspended = new Set<number>();
    for (const [numStr, list] of byNum) {
      if (list.length <= 1) continue;
      const num = Number(numStr);
      const other = side === 'old' ? newByNum.get(numStr) ?? [] : oldByNum.get(numStr) ?? [];
      // 两侧都有候选的多对多/多对一情形交给下面的统一循环处理；
      // 这里只挂起“本稿重复、另一稿完全没有同号条款”的分组。
      if (other.length > 0) continue;
      suspended.add(num);
      if (side === 'old') for (const c of list) oldUsed.add(c);
      else for (const c of list) newUsed.add(c);
      ambiguous.push({
        reason: 'duplicate_number',
        number: num,
        contentKey: null,
        message:
          side === 'old'
            ? `旧稿中编号“第${num}条”有 ${list.length} 个标题定义，新稿无同号条款；无法确定删除对应关系，请人工确认。`
            : `新稿中编号“第${num}条”有 ${list.length} 个标题定义，旧稿无同号条款；无法确定新增对应关系，请人工确认。`,
        old: side === 'old' ? list : [],
        new: side === 'new' ? list : [],
      });
    }
    return suspended;
  };

  const oldSuspendedNums = suspendOneSide('old', oldByNum);
  const newSuspendedNums = suspendOneSide('new', newByNum);

  const allNums = new Set<number>([
    ...oldLeft.map((c) => c.number),
    ...newLeft.map((c) => c.number),
  ]);

  for (const num of allNums) {
    if (oldSuspendedNums.has(num) || newSuspendedNums.has(num)) continue;
    const olds = oldByNum.get(String(num)) ?? [];
    const news = newByNum.get(String(num)) ?? [];

    if (olds.length === 1 && news.length === 1) {
      const o = olds[0];
      const n = news[0];
      oldUsed.add(o);
      newUsed.add(n);
      pairs.push({ status: statusOf(o, n), old: o, new: n });
    } else if (olds.length > 0 && news.length > 0 && (olds.length > 1 || news.length > 1)) {
      // 同编号多候选（重复标题）：不擅自挑选
      for (const o of olds) oldUsed.add(o);
      for (const n of news) newUsed.add(n);
      ambiguous.push({
        reason: 'duplicate_number',
        number: num,
        contentKey: null,
        message: `编号“第${num}条”在旧稿 / 新稿各有 ${olds.length} / ${news.length} 个同名标题，无法唯一配对，请人工确认。`,
        old: olds,
        new: news,
      });
    }
    // 仅一侧存在的同号分组留给下面的新增 / 删除。
  }

  // ---------- 单侧剩余：删除 / 新增 ----------
  for (const o of oldClauses) {
    if (oldUsed.has(o)) continue;
    oldUsed.add(o);
    pairs.push({ status: 'removed', old: o, new: null });
  }
  for (const n of newClauses) {
    if (newUsed.has(n)) continue;
    newUsed.add(n);
    pairs.push({ status: 'added', old: null, new: n });
  }

  // ---------- 稳定排序：按旧稿阅读顺序，新增条款附在文末（按新稿顺序） ----------
  pairs.sort((a, b) => {
    if (a.old && b.old) return a.old.order - b.old.order;
    if (a.old) return -1;
    if (b.old) return 1;
    return a.new!.order - b.new!.order;
  });
  ambiguous.sort((a, b) => {
    if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
    if (a.number !== null && b.number !== null) return a.number - b.number;
    return (a.contentKey ?? '').localeCompare(b.contentKey ?? '');
  });

  const counts: VersionDiff['counts'] = {
    added: 0,
    removed: 0,
    modified: 0,
    renumbered: 0,
    unchanged: 0,
    ambiguous: ambiguous.length,
  };
  for (const p of pairs) counts[p.status]++;

  const toIssues = (text2: string): DiffIssue[] =>
    analyzeText(text2)
      .issues.map((i) => ({
        kind: i.kind,
        number: i.number,
        message: i.message,
        line: i.pos.line,
      }))
      .sort((a, b) => a.line - b.line);

  return {
    oldClauseCount: oldClauses.length,
    newClauseCount: newClauses.length,
    pairs,
    ambiguous,
    oldIssues: toIssues(oldText),
    newIssues: toIssues(newText),
    counts,
  };
}
