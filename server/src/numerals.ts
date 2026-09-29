// 中文数字 <-> 阿拉伯数字 互转。
// 覆盖合同条款中常见的 0 ~ 99999999（“条”编号通常远小于此）。
// 写法沿用原文：阿拉伯输入 -> 阿拉伯输出；中文输入（含“两”）-> 中文输出。

const DIGIT_VALUE: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  〇: 0,
  壹: 1,
  贰: 2,
  叁: 3,
  肆: 4,
  伍: 5,
  陆: 6,
  柒: 7,
  捌: 8,
  玖: 9,
};

const SECTION_MULTIPLIER: Record<string, number> = {
  万: 10000,
  萬: 10000,
  亿: 100000000,
  億: 100000000,
};

/**
 * 解析中文数字字符串。仅接受由零/数字字/十百千万亿构成的内容。
 * 无法解析时返回 null。
 */
export function parseChineseNumber(s: string): number | null {
  if (!s) return null;
  let total = 0; // 已完成的节（万/亿之前）累计
  let section = 0; // 当前节（0-9999）累计
  let current = 0; // 当前小位（十/百/千）之前的数字
  let matchedAny = false;

  const flushSmall = () => {
    section += current;
    current = 0;
  };

  for (const ch of s) {
    if (ch in DIGIT_VALUE) {
      current = DIGIT_VALUE[ch];
      matchedAny = true;
    } else if (ch === '十' || ch === '拾') {
      if (current === 0) current = 1; // “十” 即 “一十”
      section += current * 10;
      current = 0;
      matchedAny = true;
    } else if (ch === '百' || ch === '佰') {
      section += current * 100;
      current = 0;
      matchedAny = true;
    } else if (ch === '千' || ch === '仟') {
      section += current * 1000;
      current = 0;
      matchedAny = true;
    } else if (ch in SECTION_MULTIPLIER) {
      flushSmall();
      total = (total + section) * SECTION_MULTIPLIER[ch];
      section = 0;
      matchedAny = true;
    } else {
      return null;
    }
  }
  flushSmall();
  const value = total + section;
  return matchedAny ? value : null;
}

const DIGITS = '零一二三四五六七八九';

/** 0-9999 -> 中文（每节内不补零的前导“一”，如 11 -> 十一） */
function fourDigitsToChinese(n: number): string {
  const parts: string[] = [];
  const thousand = Math.floor(n / 1000) % 10;
  const hundred = Math.floor(n / 100) % 10;
  const ten = Math.floor(n / 10) % 10;
  const one = n % 10;

  if (thousand) parts.push(DIGITS[thousand], '千');
  if (hundred) parts.push(DIGITS[hundred], '百');
  else if (thousand && (ten || one)) parts.push('零');
  if (ten) parts.push(ten === 1 ? '十' : DIGITS[ten] + '十');
  else if ((thousand || hundred) && one) parts.push('零');
  if (one) parts.push(DIGITS[one]);
  return parts.join('');
}

/** 非负整数 -> 中文数字，上限 99999999。 */
export function toChineseNumber(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`不支持的数字: ${n}`);
  if (n === 0) return '零';
  if (n >= 100000000) throw new Error(`条款编号超出支持范围: ${n}`);

  const sections: string[] = [];
  let rest = n;
  let first = true;
  while (rest > 0) {
    const part = rest % 10000;
    if (first) {
      sections.push(fourDigitsToChinese(part));
    } else if (part > 0) {
      let text = fourDigitsToChinese(part) + '万';
      // 高节最低位为 0 而低节最高位不足千时补“零”，如 100001 -> 十万零一
      if (part < 1000) text += '零';
      sections.push(text);
    }
    rest = Math.floor(rest / 10000);
    first = false;
  }
  return sections.reverse().join('');
}

export type NumberStyle = 'arabic' | 'chinese';

/** 识别编号文字的风格与数值 */
export function readClauseNumber(raw: string): { value: number; style: NumberStyle } | null {
  if (/^[0-9]+$/.test(raw)) {
    return { value: Number(raw), style: 'arabic' };
  }
  const value = parseChineseNumber(raw);
  if (value !== null) return { value, style: 'chinese' };
  return null;
}

/** 按指定风格渲染编号 */
export function renderClauseNumber(value: number, style: NumberStyle): string {
  return style === 'arabic' ? String(value) : toChineseNumber(value);
}
