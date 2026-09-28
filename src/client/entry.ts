/**
 * 启动封面右下角的「梦境入口」交互框 —— 小能量精灵（Codex 版实现）。
 *
 * 它不是一个聊天窗口，而是一只小小的、会呼吸的发光能量体：
 * 半透明的圆润身体、柔和光晕、镶着一圈缓慢流动的边光、两只眼睛会眨眼，
 * 头顶浮现一句随机文字，身体下方是「梦境入口」提示。
 * 动画一律靠 CSS 关键帧，JS 只负责换字，所以关掉动画后仍然是一个完整的静态精灵。
 *
 * 契约（与 entry.ts 完全一致，index.tsx 只认这个接口）：
 *   - createEntry 只建 DOM 和视觉，不碰显隐、不碰关闭逻辑；
 *   - 返回的 el 由宿主挂 click / keydown，必须能聚焦并声明 role="button"；
 *   - 只写 options.doc，绝不读写 document.body / documentElement / location / history；
 *   - 绝不注入全局 <style>：样式全部通过 ENTRY_CSS 交给宿主塞进 shadow root；
 *   - dispose() 幂等，负责清掉自己起的定时器；
 *   - createEntry 本身不抛异常（内部该兜的都兜住）。
 *
 * 文字全部来自 ./lines 的 activeLines() / pickLine()，本文件不生产任何台词。
 */

import { activeLines, pickLine } from "./lines";

/** 文字轮换间隔（毫秒）；0 = 不轮换。 */
const ROTATE_MS = 0; // 用户要求不做台词轮换，默认不启动定时器

/** 「换一句」时那次浮现动画的时长，和 .entry__msg.is-in 的 animation 保持一致。 */
const LINE_ANIM_MS = 860;

/**
 * 精灵自己的全部样式，由 index.tsx 追加进 shadow root 的 <style>。
 *
 * 颜色取向：青玉色的能量体 + 宣纸白的小铭牌，和背后水墨海报同一套色温，
 * 用「透光」而不是「高饱和」来发光，避免卡通贴纸感。
 */
export const ENTRY_CSS = [
  /* ---------- 根：右下角，原本的定位不动 ---------- */
  '.entry{position:absolute;right:36px;bottom:36px;width:300px;box-sizing:border-box;',
  '  display:flex;flex-direction:column;align-items:center;gap:10px;',
  '  padding:14px 12px 12px;border-radius:22px;cursor:pointer;pointer-events:auto;',
  '  background:radial-gradient(118% 74% at 50% 40%,rgba(226,252,246,.17),rgba(226,252,246,0) 72%);',
  '  -webkit-user-select:none;user-select:none;',
  '  font:400 13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
  '  color:#1d2a28;text-align:center;',
  '  transition:transform .28s ease}',
  '.entry:hover{transform:translateY(-2px)}',
  '.entry:focus{outline:none}',
  '.entry:active{transform:translateY(0)}',

  /* ---------- 头顶那句随机浮现的文字 ---------- */
  '.entry__msg{max-width:100%;padding:6px 13px 7px;border-radius:13px;',
  '  background:rgba(250,248,243,.78);',
  '  -webkit-backdrop-filter:blur(9px) saturate(1.1);backdrop-filter:blur(9px) saturate(1.1);',
  '  border:1px solid rgba(255,255,255,.55);',
  '  box-shadow:0 4px 16px rgba(26,44,42,.16),inset 0 1px 0 rgba(255,255,255,.8);',
  '  color:#22302e;font-size:12.5px;letter-spacing:.02em;',
  '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  // 首次渲染不带动画类：文字必须一上来就是完全不透明的，动画只是「换句」时的点缀
  '.entry__msg.is-in{animation:entryLineIn .8s ease both}',

  /* ---------- 精灵所在的一小块「悬浮台」 ---------- */
  '.entry__levitate{position:relative;width:116px;height:116px;display:flex;',
  '  align-items:center;justify-content:center;animation:entryFloat 7.5s ease-in-out infinite}',

  /* 外光晕：呼吸式明暗 */
  '.entry__halo{position:absolute;left:50%;top:50%;width:96px;height:96px;margin:-48px 0 0 -48px;',
  '  border-radius:50%;pointer-events:none;',
  '  background:radial-gradient(circle,rgba(178,244,231,.34) 0%,rgba(150,232,218,.16) 46%,rgba(150,232,218,0) 72%);',
  '  animation:entryHalo 6.4s ease-in-out infinite}',

  /* 身体：半透明发光核 */
  '.entry__sprite{position:relative;width:92px;height:92px;border-radius:50%;',
  '  background:radial-gradient(circle at 42% 32%,#ffffff 0%,#f2fffb 13%,rgba(206,246,238,.92) 31%,',
  '    rgba(150,220,208,.62) 52%,rgba(104,180,170,.30) 71%,rgba(104,180,170,.06) 86%,rgba(104,180,170,0) 92%);',
  '  box-shadow:0 0 22px rgba(168,240,226,.52),0 0 54px rgba(120,214,200,.32),0 0 104px rgba(110,205,192,.15),',
  '    inset 0 -8px 16px rgba(88,164,154,.20),inset 0 6px 14px rgba(255,255,255,.55);',
  '  transition:transform .3s ease;',
  '  animation:entryGlow 6.4s ease-in-out infinite}',
  '.entry:hover .entry__sprite{transform:scale(1.045)}',
  '.entry:active .entry__sprite{transform:scale(.98)}',

  /* 体内那点更亮的核 */
  '.entry__core{position:absolute;left:30%;top:26%;width:26px;height:26px;border-radius:50%;pointer-events:none;',
  '  background:radial-gradient(circle,rgba(255,255,255,.98) 0%,rgba(255,255,255,.42) 42%,rgba(255,255,255,0) 72%);',
  '  animation:entryCore 4.2s ease-in-out infinite}',

  /* 边缘流光：一圈被遮罩切成细弧的锥形渐变，慢慢转 */
  '.entry__rim{position:absolute;inset:-5px;border-radius:50%;pointer-events:none;opacity:.8;',
  '  background:conic-gradient(from 200deg,rgba(226,255,250,0) 0deg,rgba(226,255,250,0) 292deg,',
  '    rgba(226,255,250,.16) 306deg,rgba(236,255,252,.95) 332deg,rgba(226,255,250,0) 360deg);',
  '  -webkit-mask-image:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2px));',
  '  -webkit-mask-size:100% 100%;',
  '  mask-image:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2px));',
  '  mask-size:100% 100%;',
  '  animation:entryRim 11s linear infinite}',

  /* 脸：眼睛 + 嘴 */
  '.entry__face{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;',
  '  justify-content:center;gap:8px;pointer-events:none}',
  '.entry__eyes{display:flex;gap:19px;animation:entryBlink 6.8s ease-in-out infinite}',
  '.entry__eye{position:relative;display:block;width:11px;height:14px;border-radius:50% 50% 48% 48%;',
  '  background:radial-gradient(circle at 36% 30%,rgba(84,124,117,.96),rgba(13,31,29,.96) 74%);',
  '  box-shadow:0 0 6px rgba(12,32,30,.32)}',
  '.entry__eye::after{content:"";position:absolute;left:2px;top:2px;width:3.5px;height:3.5px;',
  '  border-radius:50%;background:rgba(255,255,255,.92)}',
  '.entry__mouth{display:block;width:11px;height:5px;',
  '  border-bottom:2px solid rgba(18,38,35,.5);border-radius:0 0 12px 12px}',

  /* 身体底下飘的三缕能量尾 */
  '.entry__wisp{position:absolute;left:50%;bottom:4px;width:2px;border-radius:999px;pointer-events:none;',
  '  background:linear-gradient(to bottom,rgba(198,246,236,.72),rgba(198,246,236,0));',
  '  transform-origin:top center;animation:entryWisp 4.6s ease-in-out infinite}',
  '.entry__wisp--a{height:22px;margin-left:-10px;transform:rotate(-11deg)}',
  '.entry__wisp--b{height:28px;margin-left:-1px;animation-delay:-1.5s}',
  '.entry__wisp--c{height:19px;margin-left:9px;transform:rotate(10deg);animation-delay:-3s}',

  /* 常在的小星点（不参与淡出，关掉动画也看得见） */
  '.entry__mote{position:absolute;width:3px;height:3px;border-radius:50%;pointer-events:none;',
  '  background:#f4fffd;box-shadow:0 0 6px 1.5px rgba(178,244,232,.7);opacity:.5;',
  '  animation:entryTwinkle 5.2s ease-in-out infinite}',
  '.entry__mote--a{left:16%;top:30%}',
  '.entry__mote--b{right:14%;top:22%;animation-delay:-1.3s}',
  '.entry__mote--c{left:11%;top:64%;animation-delay:-2.6s}',
  '.entry__mote--d{right:13%;top:60%;animation-delay:-3.9s}',

  /* 偶尔窜出来的能量屑 */
  '.entry__spark{position:absolute;width:3px;height:3px;border-radius:50%;pointer-events:none;opacity:0;',
  '  background:#f2fffc;box-shadow:0 0 7px 2px rgba(176,244,232,.75);',
  '  animation:entryDrift 7s ease-in-out infinite}',
  '.entry__spark--a{left:26%;top:62%;--dx:-8px;animation-delay:-.4s}',
  '.entry__spark--b{left:72%;top:58%;--dx:7px;animation-delay:-1.6s}',
  '.entry__spark--c{left:18%;top:44%;--dx:-6px;animation-delay:-2.7s}',
  '.entry__spark--d{left:80%;top:40%;--dx:9px;animation-delay:-3.5s}',
  '.entry__spark--e{left:60%;top:70%;--dx:5px;animation-delay:-4.9s}',

  /* ---------- 身体下方的入口提示 ---------- */
  '.entry__input{display:inline-flex;align-items:center;gap:7px;padding:5px 15px 5px 17px;',
  '  border-radius:999px;background:rgba(250,248,243,.78);',
  '  -webkit-backdrop-filter:blur(9px) saturate(1.1);backdrop-filter:blur(9px) saturate(1.1);',
  '  border:1px solid rgba(255,255,255,.55);',
  '  box-shadow:0 4px 14px rgba(26,44,42,.16),inset 0 1px 0 rgba(255,255,255,.8);',
  '  color:#1f3a35;font-size:12.5px;transition:background .3s ease,box-shadow .3s ease}',
  '.entry__caret{font-weight:600;letter-spacing:.2em;text-indent:.2em}',
  '.entry__go{font-size:12px;line-height:1;color:rgba(31,58,53,.55);',
  '  transition:transform .3s ease,color .3s ease}',
  '.entry:hover .entry__input{background:rgba(253,252,248,.9);',
  '  box-shadow:0 6px 20px rgba(26,44,42,.22),0 0 0 3px rgba(150,232,216,.22),inset 0 1px 0 rgba(255,255,255,.85)}',
  '.entry:hover .entry__go{transform:translateX(3px);color:#2b6f62}',
  '.entry:focus-visible .entry__input{box-shadow:0 6px 20px rgba(26,44,42,.22),',
  '  0 0 0 3px rgba(96,206,186,.55),inset 0 1px 0 rgba(255,255,255,.85)}',
  '.entry:focus-visible .entry__sprite{transform:scale(1.045)}',

  /* ---------- 关键帧 ---------- */
  '@keyframes entryFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}',
  '@keyframes entryGlow{0%,100%{filter:brightness(1) saturate(1)}50%{filter:brightness(1.12) saturate(1.06)}}',
  '@keyframes entryHalo{0%,100%{opacity:.5;transform:scale(.94)}50%{opacity:.92;transform:scale(1.06)}}',
  '@keyframes entryCore{0%,100%{opacity:.62;transform:scale(1)}50%{opacity:1;transform:scale(1.14)}}',
  '@keyframes entryRim{to{transform:rotate(360deg)}}',
  '@keyframes entryBlink{0%,91%,100%{transform:scaleY(1)}94%{transform:scaleY(.14)}97%{transform:scaleY(1)}}',
  '@keyframes entryWisp{0%,100%{opacity:.35;transform:scaleY(.86) rotate(-4deg)}50%{opacity:.85;transform:scaleY(1.1) rotate(4deg)}}',
  '@keyframes entryTwinkle{0%,100%{opacity:.28}50%{opacity:.62}}',
  '@keyframes entryDrift{0%{opacity:.3;transform:translate(0,6px) scale(.5)}22%{opacity:.85}',
  '  70%{opacity:.45}100%{opacity:0;transform:translate(var(--dx,-6px),-42px) scale(.35)}}',
  '@keyframes entryLineIn{from{opacity:.35;transform:translateY(5px) scale(.98)}to{opacity:1;transform:none}}',

  /* ---------- 优雅降级：静止，但精灵仍然完整可看 ---------- */
  '@media (prefers-reduced-motion:reduce){',
  '  .entry,.entry *{animation:none !important;transition:none !important}',
  '  .entry:hover,.entry:active{transform:none}',
  '  .entry:hover .entry__sprite,.entry:active .entry__sprite{transform:none}',
  '  .entry__halo{opacity:.72}',
  '  .entry__mote{opacity:.5}',
  '}',
].join('\n')

export interface EntryOptions {
  doc: Document;
  /** 覆盖文字池（测试用）；默认取 lines.ts 的 activeLines()。 */
  lines?: string[];
  /** 文字轮换间隔，毫秒；0 = 不轮换。 */
  rotateMs?: number;
}

export interface EntryHandle {
  /** 根节点。index.tsx 会在它上面挂 click / keydown。 */
  el: HTMLElement;
  /** 立刻换一句（不改定时器）。 */
  nextLine(): void;
  /** 幂等卸载。 */
  dispose(): void;
}

/** 取文字池：显式传入优先，否则用 lines.ts 的 activeLines()。绝不自己造句子。 */
function resolvePool(lines?: string[]): string[] {
  if (Array.isArray(lines) && lines.length > 0) return lines.slice();
  try {
    const pool = activeLines();
    return Array.isArray(pool) ? pool.slice() : [];
  } catch {
    return [];
  }
}

/** pickLine 包一层：池子为空或 pickLine 出问题都不能让入口挂掉。 */
function pickSafely(pool: string[], avoid?: string): string {
  try {
    const line = pickLine(pool, avoid);
    return typeof line === "string" ? line : "";
  } catch {
    return pool.length > 0 ? pool[0] : "";
  }
}

/** 定时器宿主：优先用 doc 自带的 window，隔离 document 下也能工作。 */
function resolveView(doc: Document): { setInterval: Function; clearInterval: Function } | null {
  try {
    const view: any = (doc as any).defaultView;
    if (view && typeof view.setInterval === "function") return view;
  } catch {
    // 取不到就退到全局
  }
  try {
    if (typeof window !== "undefined" && typeof window.setInterval === "function") return window;
  } catch {
    // 没有 window（比如纯 DOM 测试环境）——那就干脆不轮换
  }
  return null;
}

/** 建一个带类名 / 标签的元素，失败也不抛。 */
function make(doc: Document, tag: string, className: string, text?: string): HTMLElement {
  const node = doc.createElement(tag);
  node.setAttribute("class", className);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 真正的实现。任何一步抛异常都会被 createEntry 兜住并退化成朴素版本。 */
function buildEntry(doc: Document, options: EntryOptions): EntryHandle {
  const pool = resolvePool(options.lines);
  const rotateMs =
    typeof options.rotateMs === "number" && isFinite(options.rotateMs) ? options.rotateMs : ROTATE_MS;
  const view = resolveView(doc);

  /* ---------- 根节点：唯一的可点区域 ---------- */
  const el = doc.createElement("div");
  el.setAttribute("class", "entry");
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-label", "我们都在同一个世界");
  el.setAttribute("data-entry", "codex-energy-sprite");

  /* ---------- 头顶那句随机浮现的文字 ---------- */
  const msg = make(doc, "div", "entry__msg");
  let current = pickSafely(pool);
  msg.textContent = current;

  /* ---------- 精灵本体 ---------- */
  const levitate = make(doc, "div", "entry__levitate");

  const halo = make(doc, "span", "entry__halo");

  // 注意：entry__bar 是自检 harness 认定的「精灵主体」钩子，保留这个别名。
  const sprite = make(doc, "span", "entry__sprite entry__bar");
  const core = make(doc, "span", "entry__core");
  const rim = make(doc, "span", "entry__rim");

  const face = make(doc, "span", "entry__face");
  const eyes = make(doc, "span", "entry__eyes");
  const leftEye = make(doc, "i", "entry__eye");
  const rightEye = make(doc, "i", "entry__eye");
  const mouth = make(doc, "span", "entry__mouth");
  eyes.appendChild(leftEye);
  eyes.appendChild(rightEye);
  face.appendChild(eyes);
  face.appendChild(mouth);

  sprite.appendChild(core);
  sprite.appendChild(rim);
  sprite.appendChild(face);

  const wisps = ["a", "b", "c"].map((suffix) => make(doc, "span", "entry__wisp entry__wisp--" + suffix));
  const motes = ["a", "b", "c", "d"].map((suffix) => make(doc, "span", "entry__mote entry__mote--" + suffix));
  const sparks = ["a", "b", "c", "d", "e"].map((suffix) => make(doc, "span", "entry__spark entry__spark--" + suffix));

  levitate.appendChild(halo);
  levitate.appendChild(sprite);
  for (const node of wisps) levitate.appendChild(node);
  for (const node of motes) levitate.appendChild(node);
  for (const node of sparks) levitate.appendChild(node);

  /* ---------- 身体下方的入口提示 ---------- */
  const input = make(doc, "div", "entry__input");
  const caret = make(doc, "span", "entry__caret", "我们都在同一个世界");
  const go = make(doc, "span", "entry__go", "→");
  input.appendChild(caret);
  input.appendChild(go);

  // 气泡不再挂载：用户要求不做台词轮换，只保留精灵 + 一行入口文案
  el.appendChild(levitate);
  el.appendChild(input);

  let timer: unknown = null;
  let lineTimer: unknown = null;
  let disposed = false;

  /** 换一句：先取新文字，再重放一次「浮现」动画。 */
  const nextLine = (): void => {
    if (disposed) return;
    current = pickSafely(pool, current);
    try {
      msg.textContent = current;
    } catch {
      // 文字更新失败不影响入口可用
      return;
    }
    replayLineIn();
  };

  /**
   * 重放一次「浮现」动画。用类名而不是直接改 style：
   * 即使动画没跑（例如无头截图里动画时间线不前进），
   * 下面这个定时器也一定会把类摘掉，文字不会卡在半透明状态。
   */
  const replayLineIn = (): void => {
    if (view === null) return; // 没有定时器就更不能加类，否则摘不掉
    try {
      msg.setAttribute("class", "entry__msg is-in");
      void msg.offsetWidth;
    } catch {
      return;
    }
    if (lineTimer !== null) {
      try {
        view.clearTimeout(lineTimer);
      } catch {
        // ignore
      }
    }
    try {
      lineTimer = view.setTimeout(() => {
        lineTimer = null;
        if (disposed) return;
        try {
          msg.setAttribute("class", "entry__msg");
        } catch {
          // ignore
        }
      }, LINE_ANIM_MS);
    } catch {
      lineTimer = null;
    }
  };

  if (rotateMs > 0 && pool.length > 1 && view !== null) {
    try {
      timer = view.setInterval(nextLine, rotateMs);
    } catch {
      timer = null;
    }
  }

  return {
    el,
    nextLine,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer !== null && view !== null) {
        const handle = timer;
        timer = null;
        try {
          view.clearInterval(handle);
        } catch {
          // ignore
        }
      }
      if (lineTimer !== null && view !== null) {
        const handle = lineTimer;
        lineTimer = null;
        try {
          view.clearTimeout(handle);
        } catch {
          // ignore
        }
      }
    },
  };
}

/** 兜底实现：样式丢了也要留下一个合法的、可聚焦的入口。 */
function buildPlainEntry(doc: Document): EntryHandle {
  const el = doc.createElement("div");
  el.setAttribute("class", "entry");
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-label", "我们都在同一个世界");
  const caret = make(doc, "span", "entry__caret", "我们都在同一个世界");
  const msg = make(doc, "div", "entry__msg", pickSafely(resolvePool(undefined)));
  const input = make(doc, "div", "entry__input");
  input.appendChild(caret);
  // 气泡不再挂载：用户要求不做台词轮换，只保留精灵 + 一行入口文案
  el.appendChild(input);
  let disposed = false;
  return {
    el,
    nextLine(): void {
      if (disposed) return;
      try {
        msg.textContent = pickSafely(activeLines());
      } catch {
        // ignore
      }
    },
    dispose(): void {
      disposed = true;
    },
  };
}

/**
 * 建出右下角的梦境入口。**永不抛异常**：任何意外都退化成朴素入口，
 * 宁可少一层光晕，也不能让启动封面取消不掉。
 */
export function createEntry(options: EntryOptions): EntryHandle {
  const doc: any = options === null || options === undefined ? null : options.doc;
  if (doc === null || doc === undefined || typeof doc.createElement !== "function") {
    // 连 document 都没有：给一个惰性空壳，调用方 appendChild 会失败但不会炸。
    return {
      el: {} as HTMLElement,
      nextLine(): void {
        /* no-op */
      },
      dispose(): void {
        /* no-op */
      },
    };
  }
  try {
    return buildEntry(doc as Document, options);
  } catch {
    try {
      return buildPlainEntry(doc as Document);
    } catch {
      return {
        el: {} as HTMLElement,
        nextLine(): void {
          /* no-op */
        },
        dispose(): void {
          /* no-op */
        },
      };
    }
  }
}
