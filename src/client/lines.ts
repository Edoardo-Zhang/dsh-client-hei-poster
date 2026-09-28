/**
 * 交互框里随机浮现的文字池。
 *
 * ⚠️ 这个数组**故意留空成占位**：
 * 我没有可靠的来源核实《罗小黑战记》的真实台词（抓到的页面都是 JS 壳），
 * 与其编几句假的冒充电影台词，不如留给你自己粘。
 *
 * 用法：把你想用的台词一行一句填进 REAL_LINES 即可，别的什么都不用改。
 *
 *   export const REAL_LINES: string[] = [
 *     "……",
 *     "……",
 *   ]
 *
 * 填进去之后，交互框会在每次显示时随机挑一句（同一次显示内不重复）。
 * REAL_LINES 为空时，自动退回到下面这组不冒充台词的氛围占位句。
 */

/** 你自己填的台词。留空就是用下面的占位。 */
export const REAL_LINES: string[] = [
  // 在这里一行一句地填。例如：
  // "……",
];

/**
 * 占位句：只描述画面氛围，**不声称出自电影**。
 * 一旦 REAL_LINES 有内容，这组就不会被用到。
 */
export const PLACEHOLDER_LINES: string[] = [
  "我们都在同一个世界。",
  "风声、树影、还有一点微光。",
  "慢慢来，不着急。",
  "这里很安静。",
  "往前走一步就到了。",
];

/** 实际使用的文字池：优先你的台词，否则用占位。 */
export function activeLines(): string[] {
  return REAL_LINES.length > 0 ? REAL_LINES : PLACEHOLDER_LINES;
}

/** 从池子里随机挑一句；avoid 用于避免和上一次重复。 */
export function pickLine(pool: string[], avoid?: string): string {
  if (pool.length === 0) return "";
  if (pool.length === 1) return pool[0];
  const candidates = avoid === undefined ? pool : pool.filter((line) => line !== avoid);
  const from = candidates.length > 0 ? candidates : pool;
  return from[Math.floor(Math.random() * from.length)];
}
