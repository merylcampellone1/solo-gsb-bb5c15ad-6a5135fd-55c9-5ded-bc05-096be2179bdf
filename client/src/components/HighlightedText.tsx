// 将文本中的“第X条”切分，命中目标编号集合的 token 用 <mark> 高亮。
// 定界符是完整的“第/条”token，因此第1条不会误匹配第10条。

import { Fragment, type ReactNode } from 'react';

const TOKEN_RE = new RegExp(
  '第([0-9]+|[〇零一二两三四五六七八九十百千万億萬壹贰叁肆伍陆柒捌玖拾佰仟亿]+)条',
  'g',
);

const DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
  壹: 1, 贰: 2, 叁: 3, 肆: 4, 伍: 5, 陆: 6, 柒: 7, 捌: 8, 玖: 9,
};
const SMALL: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };
const BIG: Record<string, number> = { 万: 10000, 萬: 10000, 亿: 100000000, 億: 100000000 };

function parseNumber(raw: string): number | null {
  if (/^[0-9]+$/.test(raw)) return Number(raw);
  let total = 0;
  let section = 0;
  let cur = 0;
  let any = false;
  for (const ch of raw) {
    if (ch in DIGIT) {
      cur = DIGIT[ch];
      any = true;
    } else if (ch in SMALL) {
      if (cur === 0) cur = 1;
      section += cur * SMALL[ch];
      cur = 0;
      any = true;
    } else if (ch in BIG) {
      section += cur;
      total = (total + section) * BIG[ch];
      section = 0;
      cur = 0;
      any = true;
    } else {
      return null;
    }
  }
  return any ? total + section + cur : null;
}

export default function HighlightedText({
  text,
  targets,
}: {
  text: string;
  targets: Set<number>;
}) {
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const v = parseNumber(m[1]);
    if (m.index > last) parts.push(<Fragment key={key++}>{text.slice(last, m.index)}</Fragment>);
    const hit = v !== null && targets.has(v);
    parts.push(
      hit ? (
        <mark key={key++} className="token-hit" title="本次改号">
          {m[0]}
        </mark>
      ) : (
        <Fragment key={key++}>{m[0]}</Fragment>
      ),
    );
    last = m.index + m[0].length;
  }
  parts.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return <pre className="preview-text">{parts}</pre>;
}
