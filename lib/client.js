window.__ModuleLoader__.load({id:"dsh-client-hei-poster",factory:(require)=>{var module={exports:{}};var exports=module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/overlay.ts
var INPUT_ARMING_MS = 250;
var AUTO_DISMISS_MS = 3e4;
var OCCLUSION_BLUR_MS = 800;
var OverlayController = class {
  deps;
  showing = false;
  shownAt = Number.NEGATIVE_INFINITY;
  timerActive = false;
  timer = null;
  unsubscribe = null;
  wasHidden = false;
  started = false;
  disposed = false;
  /** When the page last blurred while still visible; null when focused. */
  blurredWhileVisibleAt = null;
  /** Whether the pending hidden -> visible edge should re-show the cover. */
  restoreArmed = false;
  unsubscribeFocus = null;
  constructor(deps) {
    this.deps = deps;
  }
  /** Whether the cover is currently on screen. */
  get visible() {
    return this.showing;
  }
  /** Whether {@link OverlayController.dispose} already ran. */
  get isDisposed() {
    return this.disposed;
  }
  /**
   * Show the cover now and start watching for hidden -> visible transitions.
   * Safe to call more than once; only the first call has an effect.
   */
  start() {
    if (this.disposed || this.started) return;
    this.started = true;
    if (this.isDisabled()) {
      this.log("start(): suppressed by the disable flag; the cover stays hidden");
      return;
    }
    try {
      this.wasHidden = this.deps.isHidden();
      this.unsubscribe = this.deps.onVisibilityChange(() => this.handleVisibilityChange());
    } catch (error) {
      this.log("start(): visibility subscription failed: " + describe(error));
      this.unsubscribe = null;
      this.wasHidden = false;
    }
    const onFocusChange = this.deps.onFocusChange;
    if (onFocusChange !== void 0) {
      try {
        this.unsubscribeFocus = onFocusChange((focused) => this.handleFocusChange(focused));
      } catch (error) {
        this.log("start(): focus subscription failed: " + describe(error));
        this.unsubscribeFocus = null;
      }
    }
    this.show();
  }
  /**
   * Show the cover. Idempotent: it never stacks timers or subscriptions, and it
   * re-arms both the click delay and the fail-safe timeout of the new appearance.
   *
   * The disable switch is re-checked here, so a cover that was suppressed at boot
   * cannot sneak back in through the tray-restore path (M-3). A suppressed show()
   * leaves "showing" false and arms no timer.
   */
  show() {
    if (this.disposed) return;
    if (this.isDisabled()) {
      this.log("show(): suppressed by the disable flag; the cover stays hidden");
      return;
    }
    this.showing = true;
    this.shownAt = this.deps.now();
    try {
      this.deps.show();
    } catch (error) {
      this.log("show() failed: " + describe(error));
    }
    this.clearAutoDismiss();
    this.timer = this.deps.setTimer(() => {
      this.timerActive = false;
      this.timer = null;
      this.dismiss("timeout");
    }, AUTO_DISMISS_MS);
    this.timerActive = true;
    this.log("show()");
  }
  /**
   * Hide the cover.
   * @param reason Why it is going away; "click" is gated by {@link INPUT_ARMING_MS}.
   */
  dismiss(reason) {
    if (this.disposed || !this.showing) return;
    if (reason === "click" && this.deps.now() - this.shownAt < INPUT_ARMING_MS) {
      this.log("dismiss(click): ignored, still inside the arming window");
      return;
    }
    this.showing = false;
    this.clearAutoDismiss();
    try {
      this.deps.hide();
    } catch (error) {
      this.log("hide() failed: " + describe(error));
    }
    this.log("dismiss(" + reason + ")");
  }
  /** Release everything. Idempotent; later show()/dismiss() calls do nothing. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearAutoDismiss();
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    if (unsubscribe !== null) {
      try {
        unsubscribe();
      } catch (error) {
        this.log("unsubscribe failed: " + describe(error));
      }
    }
    const unsubscribeFocus = this.unsubscribeFocus;
    this.unsubscribeFocus = null;
    if (unsubscribeFocus !== null) {
      try {
        unsubscribeFocus();
      } catch (error) {
        this.log("focus unsubscribe failed: " + describe(error));
      }
    }
    if (this.showing) {
      this.showing = false;
      try {
        this.deps.hide();
      } catch (error) {
        this.log("hide() on dispose failed: " + describe(error));
      }
    }
    this.log("dispose()");
  }
  handleVisibilityChange() {
    if (this.disposed) return;
    const hidden = this.deps.isHidden();
    const wasHidden = this.wasHidden;
    this.wasHidden = hidden;
    if (!wasHidden && hidden) {
      this.restoreArmed = !this.lookedOccluded();
      this.log("page hidden; will re-show on return = " + this.restoreArmed);
      return;
    }
    if (wasHidden && !hidden) {
      if (!this.restoreArmed) {
        this.log("visible again, but the hide looked like occlusion; cover stays away");
        return;
      }
      this.log("page became visible again");
      this.show();
    }
  }
  /**
   * True when the page sat blurred-but-visible long enough before going hidden
   * that Chromium occlusion is the likely reason (see OCCLUSION_BLUR_MS).
   */
  lookedOccluded() {
    const blurredAt = this.blurredWhileVisibleAt;
    if (blurredAt === null) return false;
    try {
      return this.deps.now() - blurredAt >= OCCLUSION_BLUR_MS;
    } catch (error) {
      this.log("lookedOccluded() failed: " + describe(error));
      return false;
    }
  }
  /** Track blurred-while-visible, the one thing that separates occlusion from a real hide. */
  handleFocusChange(focused) {
    if (this.disposed) return;
    if (focused) {
      this.blurredWhileVisibleAt = null;
      return;
    }
    let hidden = false;
    try {
      hidden = this.deps.isHidden();
    } catch (error) {
      this.log("handleFocusChange() could not read visibility: " + describe(error));
      hidden = false;
    }
    this.blurredWhileVisibleAt = hidden ? null : this.deps.now();
  }
  /** Evaluate the optional kill switch; a broken one must not break show(). */
  isDisabled() {
    const disabled = this.deps.disabled;
    if (disabled === void 0) return false;
    try {
      return disabled() === true;
    } catch (error) {
      this.log("disabled() threw: " + describe(error));
      return false;
    }
  }
  clearAutoDismiss() {
    if (!this.timerActive) return;
    const handle = this.timer;
    this.timerActive = false;
    this.timer = null;
    try {
      this.deps.clearTimer(handle);
    } catch (error) {
      this.log("clearTimer failed: " + describe(error));
    }
  }
  log(message) {
    try {
      this.deps.log?.(message);
    } catch {
    }
  }
};
function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

// src/client/lines.ts
var REAL_LINES = [
  // 在这里一行一句地填。例如：
  // "……",
];
var PLACEHOLDER_LINES = [
  "\u6211\u4EEC\u90FD\u5728\u540C\u4E00\u4E2A\u4E16\u754C\u3002",
  "\u98CE\u58F0\u3001\u6811\u5F71\u3001\u8FD8\u6709\u4E00\u70B9\u5FAE\u5149\u3002",
  "\u6162\u6162\u6765\uFF0C\u4E0D\u7740\u6025\u3002",
  "\u8FD9\u91CC\u5F88\u5B89\u9759\u3002",
  "\u5F80\u524D\u8D70\u4E00\u6B65\u5C31\u5230\u4E86\u3002"
];
function activeLines() {
  return REAL_LINES.length > 0 ? REAL_LINES : PLACEHOLDER_LINES;
}
function pickLine(pool, avoid) {
  if (pool.length === 0) return "";
  if (pool.length === 1) return pool[0];
  const candidates = avoid === void 0 ? pool : pool.filter((line) => line !== avoid);
  const from = candidates.length > 0 ? candidates : pool;
  return from[Math.floor(Math.random() * from.length)];
}

// src/client/entry.ts
var ROTATE_MS = 0;
var LINE_ANIM_MS = 860;
var ENTRY_CSS = [
  /* ---------- 根：右下角，原本的定位不动 ---------- */
  ".entry{position:absolute;right:36px;bottom:36px;width:300px;box-sizing:border-box;",
  "  display:flex;flex-direction:column;align-items:center;gap:10px;",
  "  padding:14px 12px 12px;border-radius:22px;cursor:pointer;pointer-events:auto;",
  "  background:radial-gradient(118% 74% at 50% 40%,rgba(226,252,246,.17),rgba(226,252,246,0) 72%);",
  "  -webkit-user-select:none;user-select:none;",
  '  font:400 13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
  "  color:#1d2a28;text-align:center;",
  "  transition:transform .28s ease}",
  ".entry:hover{transform:translateY(-2px)}",
  ".entry:focus{outline:none}",
  ".entry:active{transform:translateY(0)}",
  /* ---------- 头顶那句随机浮现的文字 ---------- */
  ".entry__msg{max-width:100%;padding:6px 13px 7px;border-radius:13px;",
  "  background:rgba(250,248,243,.78);",
  "  -webkit-backdrop-filter:blur(9px) saturate(1.1);backdrop-filter:blur(9px) saturate(1.1);",
  "  border:1px solid rgba(255,255,255,.55);",
  "  box-shadow:0 4px 16px rgba(26,44,42,.16),inset 0 1px 0 rgba(255,255,255,.8);",
  "  color:#22302e;font-size:12.5px;letter-spacing:.02em;",
  "  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  // 首次渲染不带动画类：文字必须一上来就是完全不透明的，动画只是「换句」时的点缀
  ".entry__msg.is-in{animation:entryLineIn .8s ease both}",
  /* ---------- 精灵所在的一小块「悬浮台」 ---------- */
  ".entry__levitate{position:relative;width:116px;height:116px;display:flex;",
  "  align-items:center;justify-content:center;animation:entryFloat 7.5s ease-in-out infinite}",
  /* 外光晕：呼吸式明暗 */
  ".entry__halo{position:absolute;left:50%;top:50%;width:96px;height:96px;margin:-48px 0 0 -48px;",
  "  border-radius:50%;pointer-events:none;",
  "  background:radial-gradient(circle,rgba(178,244,231,.34) 0%,rgba(150,232,218,.16) 46%,rgba(150,232,218,0) 72%);",
  "  animation:entryHalo 6.4s ease-in-out infinite}",
  /* 身体：半透明发光核 */
  ".entry__sprite{position:relative;width:92px;height:92px;border-radius:50%;",
  "  background:radial-gradient(circle at 42% 32%,#ffffff 0%,#f2fffb 13%,rgba(206,246,238,.92) 31%,",
  "    rgba(150,220,208,.62) 52%,rgba(104,180,170,.30) 71%,rgba(104,180,170,.06) 86%,rgba(104,180,170,0) 92%);",
  "  box-shadow:0 0 22px rgba(168,240,226,.52),0 0 54px rgba(120,214,200,.32),0 0 104px rgba(110,205,192,.15),",
  "    inset 0 -8px 16px rgba(88,164,154,.20),inset 0 6px 14px rgba(255,255,255,.55);",
  "  transition:transform .3s ease;",
  "  animation:entryGlow 6.4s ease-in-out infinite}",
  ".entry:hover .entry__sprite{transform:scale(1.045)}",
  ".entry:active .entry__sprite{transform:scale(.98)}",
  /* 体内那点更亮的核 */
  ".entry__core{position:absolute;left:30%;top:26%;width:26px;height:26px;border-radius:50%;pointer-events:none;",
  "  background:radial-gradient(circle,rgba(255,255,255,.98) 0%,rgba(255,255,255,.42) 42%,rgba(255,255,255,0) 72%);",
  "  animation:entryCore 4.2s ease-in-out infinite}",
  /* 边缘流光：一圈被遮罩切成细弧的锥形渐变，慢慢转 */
  ".entry__rim{position:absolute;inset:-5px;border-radius:50%;pointer-events:none;opacity:.8;",
  "  background:conic-gradient(from 200deg,rgba(226,255,250,0) 0deg,rgba(226,255,250,0) 292deg,",
  "    rgba(226,255,250,.16) 306deg,rgba(236,255,252,.95) 332deg,rgba(226,255,250,0) 360deg);",
  "  -webkit-mask-image:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2px));",
  "  -webkit-mask-size:100% 100%;",
  "  mask-image:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2px));",
  "  mask-size:100% 100%;",
  "  animation:entryRim 11s linear infinite}",
  /* 脸：眼睛 + 嘴 */
  ".entry__face{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;",
  "  justify-content:center;gap:8px;pointer-events:none}",
  ".entry__eyes{display:flex;gap:19px;animation:entryBlink 6.8s ease-in-out infinite}",
  ".entry__eye{position:relative;display:block;width:11px;height:14px;border-radius:50% 50% 48% 48%;",
  "  background:radial-gradient(circle at 36% 30%,rgba(84,124,117,.96),rgba(13,31,29,.96) 74%);",
  "  box-shadow:0 0 6px rgba(12,32,30,.32)}",
  '.entry__eye::after{content:"";position:absolute;left:2px;top:2px;width:3.5px;height:3.5px;',
  "  border-radius:50%;background:rgba(255,255,255,.92)}",
  ".entry__mouth{display:block;width:11px;height:5px;",
  "  border-bottom:2px solid rgba(18,38,35,.5);border-radius:0 0 12px 12px}",
  /* 身体底下飘的三缕能量尾 */
  ".entry__wisp{position:absolute;left:50%;bottom:4px;width:2px;border-radius:999px;pointer-events:none;",
  "  background:linear-gradient(to bottom,rgba(198,246,236,.72),rgba(198,246,236,0));",
  "  transform-origin:top center;animation:entryWisp 4.6s ease-in-out infinite}",
  ".entry__wisp--a{height:22px;margin-left:-10px;transform:rotate(-11deg)}",
  ".entry__wisp--b{height:28px;margin-left:-1px;animation-delay:-1.5s}",
  ".entry__wisp--c{height:19px;margin-left:9px;transform:rotate(10deg);animation-delay:-3s}",
  /* 常在的小星点（不参与淡出，关掉动画也看得见） */
  ".entry__mote{position:absolute;width:3px;height:3px;border-radius:50%;pointer-events:none;",
  "  background:#f4fffd;box-shadow:0 0 6px 1.5px rgba(178,244,232,.7);opacity:.5;",
  "  animation:entryTwinkle 5.2s ease-in-out infinite}",
  ".entry__mote--a{left:16%;top:30%}",
  ".entry__mote--b{right:14%;top:22%;animation-delay:-1.3s}",
  ".entry__mote--c{left:11%;top:64%;animation-delay:-2.6s}",
  ".entry__mote--d{right:13%;top:60%;animation-delay:-3.9s}",
  /* 偶尔窜出来的能量屑 */
  ".entry__spark{position:absolute;width:3px;height:3px;border-radius:50%;pointer-events:none;opacity:0;",
  "  background:#f2fffc;box-shadow:0 0 7px 2px rgba(176,244,232,.75);",
  "  animation:entryDrift 7s ease-in-out infinite}",
  ".entry__spark--a{left:26%;top:62%;--dx:-8px;animation-delay:-.4s}",
  ".entry__spark--b{left:72%;top:58%;--dx:7px;animation-delay:-1.6s}",
  ".entry__spark--c{left:18%;top:44%;--dx:-6px;animation-delay:-2.7s}",
  ".entry__spark--d{left:80%;top:40%;--dx:9px;animation-delay:-3.5s}",
  ".entry__spark--e{left:60%;top:70%;--dx:5px;animation-delay:-4.9s}",
  /* ---------- 身体下方的入口提示 ---------- */
  ".entry__input{display:inline-flex;align-items:center;gap:7px;padding:5px 15px 5px 17px;",
  "  border-radius:999px;background:rgba(250,248,243,.78);",
  "  -webkit-backdrop-filter:blur(9px) saturate(1.1);backdrop-filter:blur(9px) saturate(1.1);",
  "  border:1px solid rgba(255,255,255,.55);",
  "  box-shadow:0 4px 14px rgba(26,44,42,.16),inset 0 1px 0 rgba(255,255,255,.8);",
  "  color:#1f3a35;font-size:12.5px;transition:background .3s ease,box-shadow .3s ease}",
  ".entry__caret{font-weight:600;letter-spacing:.2em;text-indent:.2em}",
  ".entry__go{font-size:12px;line-height:1;color:rgba(31,58,53,.55);",
  "  transition:transform .3s ease,color .3s ease}",
  ".entry:hover .entry__input{background:rgba(253,252,248,.9);",
  "  box-shadow:0 6px 20px rgba(26,44,42,.22),0 0 0 3px rgba(150,232,216,.22),inset 0 1px 0 rgba(255,255,255,.85)}",
  ".entry:hover .entry__go{transform:translateX(3px);color:#2b6f62}",
  ".entry:focus-visible .entry__input{box-shadow:0 6px 20px rgba(26,44,42,.22),",
  "  0 0 0 3px rgba(96,206,186,.55),inset 0 1px 0 rgba(255,255,255,.85)}",
  ".entry:focus-visible .entry__sprite{transform:scale(1.045)}",
  /* ---------- 关键帧 ---------- */
  "@keyframes entryFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}",
  "@keyframes entryGlow{0%,100%{filter:brightness(1) saturate(1)}50%{filter:brightness(1.12) saturate(1.06)}}",
  "@keyframes entryHalo{0%,100%{opacity:.5;transform:scale(.94)}50%{opacity:.92;transform:scale(1.06)}}",
  "@keyframes entryCore{0%,100%{opacity:.62;transform:scale(1)}50%{opacity:1;transform:scale(1.14)}}",
  "@keyframes entryRim{to{transform:rotate(360deg)}}",
  "@keyframes entryBlink{0%,91%,100%{transform:scaleY(1)}94%{transform:scaleY(.14)}97%{transform:scaleY(1)}}",
  "@keyframes entryWisp{0%,100%{opacity:.35;transform:scaleY(.86) rotate(-4deg)}50%{opacity:.85;transform:scaleY(1.1) rotate(4deg)}}",
  "@keyframes entryTwinkle{0%,100%{opacity:.28}50%{opacity:.62}}",
  "@keyframes entryDrift{0%{opacity:.3;transform:translate(0,6px) scale(.5)}22%{opacity:.85}",
  "  70%{opacity:.45}100%{opacity:0;transform:translate(var(--dx,-6px),-42px) scale(.35)}}",
  "@keyframes entryLineIn{from{opacity:.35;transform:translateY(5px) scale(.98)}to{opacity:1;transform:none}}",
  /* ---------- 优雅降级：静止，但精灵仍然完整可看 ---------- */
  "@media (prefers-reduced-motion:reduce){",
  "  .entry,.entry *{animation:none !important;transition:none !important}",
  "  .entry:hover,.entry:active{transform:none}",
  "  .entry:hover .entry__sprite,.entry:active .entry__sprite{transform:none}",
  "  .entry__halo{opacity:.72}",
  "  .entry__mote{opacity:.5}",
  "}"
].join("\n");
function resolvePool(lines) {
  if (Array.isArray(lines) && lines.length > 0) return lines.slice();
  try {
    const pool = activeLines();
    return Array.isArray(pool) ? pool.slice() : [];
  } catch {
    return [];
  }
}
function pickSafely(pool, avoid) {
  try {
    const line = pickLine(pool, avoid);
    return typeof line === "string" ? line : "";
  } catch {
    return pool.length > 0 ? pool[0] : "";
  }
}
function resolveView(doc) {
  try {
    const view = doc.defaultView;
    if (view && typeof view.setInterval === "function") return view;
  } catch {
  }
  try {
    if (typeof window !== "undefined" && typeof window.setInterval === "function") return window;
  } catch {
  }
  return null;
}
function make(doc, tag, className, text) {
  const node = doc.createElement(tag);
  node.setAttribute("class", className);
  if (text !== void 0) node.textContent = text;
  return node;
}
function buildEntry(doc, options) {
  const pool = resolvePool(options.lines);
  const rotateMs = typeof options.rotateMs === "number" && isFinite(options.rotateMs) ? options.rotateMs : ROTATE_MS;
  const view = resolveView(doc);
  const el = doc.createElement("div");
  el.setAttribute("class", "entry");
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-label", "\u6211\u4EEC\u90FD\u5728\u540C\u4E00\u4E2A\u4E16\u754C");
  el.setAttribute("data-entry", "codex-energy-sprite");
  const msg = make(doc, "div", "entry__msg");
  let current = pickSafely(pool);
  msg.textContent = current;
  const levitate = make(doc, "div", "entry__levitate");
  const halo = make(doc, "span", "entry__halo");
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
  const input = make(doc, "div", "entry__input");
  const caret = make(doc, "span", "entry__caret", "\u6211\u4EEC\u90FD\u5728\u540C\u4E00\u4E2A\u4E16\u754C");
  const go = make(doc, "span", "entry__go", "\u2192");
  input.appendChild(caret);
  input.appendChild(go);
  el.appendChild(levitate);
  el.appendChild(input);
  let timer = null;
  let lineTimer = null;
  let disposed = false;
  const nextLine = () => {
    if (disposed) return;
    current = pickSafely(pool, current);
    try {
      msg.textContent = current;
    } catch {
      return;
    }
    replayLineIn();
  };
  const replayLineIn = () => {
    if (view === null) return;
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
      }
    }
    try {
      lineTimer = view.setTimeout(() => {
        lineTimer = null;
        if (disposed) return;
        try {
          msg.setAttribute("class", "entry__msg");
        } catch {
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
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null && view !== null) {
        const handle = timer;
        timer = null;
        try {
          view.clearInterval(handle);
        } catch {
        }
      }
      if (lineTimer !== null && view !== null) {
        const handle = lineTimer;
        lineTimer = null;
        try {
          view.clearTimeout(handle);
        } catch {
        }
      }
    }
  };
}
function buildPlainEntry(doc) {
  const el = doc.createElement("div");
  el.setAttribute("class", "entry");
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-label", "\u6211\u4EEC\u90FD\u5728\u540C\u4E00\u4E2A\u4E16\u754C");
  const caret = make(doc, "span", "entry__caret", "\u6211\u4EEC\u90FD\u5728\u540C\u4E00\u4E2A\u4E16\u754C");
  const msg = make(doc, "div", "entry__msg", pickSafely(resolvePool(void 0)));
  const input = make(doc, "div", "entry__input");
  input.appendChild(caret);
  el.appendChild(input);
  let disposed = false;
  return {
    el,
    nextLine() {
      if (disposed) return;
      try {
        msg.textContent = pickSafely(activeLines());
      } catch {
      }
    },
    dispose() {
      disposed = true;
    }
  };
}
function createEntry(options) {
  const doc = options === null || options === void 0 ? null : options.doc;
  if (doc === null || doc === void 0 || typeof doc.createElement !== "function") {
    return {
      el: {},
      nextLine() {
      },
      dispose() {
      }
    };
  }
  try {
    return buildEntry(doc, options);
  } catch {
    try {
      return buildPlainEntry(doc);
    } catch {
      return {
        el: {},
        nextLine() {
        },
        dispose() {
        }
      };
    }
  }
}

// src/client/index.tsx
var PACKAGE_ID = "dsh-client-hei-poster";
var ASSET_BASE = "/plugins/" + PACKAGE_ID + "/assets/";
var POSTER_FILES = ["poster-a.png", "poster-b.png"];
var POSTER_INDEX_KEY = "hei.posterIndex";
var OVERLAY_ELEMENT_ID = "hei-poster-overlay";
var OFF_STORAGE_KEY = "hei.noPoster";
var OFF_ATTRIBUTE = "data-hei-off";
var DEGRADED_CLASS = "hei-poster-root";
var BODY_WAIT_TIMEOUT_MS = 1e4;
var BODY_POLL_MS = 250;
var OVERLAY_STYLE = "position:fixed;inset:0;top:0;right:0;bottom:0;left:0;z-index:2000;display:block;background:linear-gradient(160deg,#f2ece4 0%,#e6dfd6 55%,#d8d0c6 100%);";
var COVER_CSS = [
  ":host{all:initial}",
  ".stage{position:absolute;inset:0;overflow:hidden}",
  ".poster{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center;display:none;user-select:none;-webkit-user-drag:none}",
  ".poster.is-on{display:block}"
].join("\n");
function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
function warn(message, error) {
  try {
    if (error === void 0) console.warn("[" + PACKAGE_ID + "] " + message);
    else console.warn("[" + PACKAGE_ID + "] " + message + ": " + describeError(error));
  } catch {
  }
}
function debug(message) {
  try {
    console.debug("[" + PACKAGE_ID + "] " + message);
  } catch {
  }
}
function searchHasFlag(name) {
  try {
    const search = String(window.location?.search ?? "");
    if (search.indexOf(name + "=1") >= 0) return true;
    return new URLSearchParams(search).get(name) === "1";
  } catch {
    return false;
  }
}
function isDisabled() {
  try {
    if (Boolean(window.__HEI_POSTER_DISABLE__)) return true;
  } catch {
  }
  try {
    const stored = window.localStorage === void 0 ? null : window.localStorage.getItem(OFF_STORAGE_KEY);
    if (stored === "1") return true;
  } catch {
  }
  try {
    if (document.documentElement.hasAttribute(OFF_ATTRIBUTE)) return true;
  } catch {
  }
  return searchHasFlag("noPoster");
}
function nextPosterIndex(readStored) {
  let last = null;
  try {
    last = readStored();
  } catch {
    last = null;
  }
  if (last === null || !Number.isFinite(last) || last < 0) return { show: 0, store: 0 };
  const show = (Math.trunc(last) + 1) % POSTER_FILES.length;
  return { show, store: show };
}
function attachWhenBodyReady(doc, mount, giveUp) {
  let cancelled = false;
  let finished = false;
  let timer = null;
  let listener = null;
  const stopWatching = () => {
    if (finished) return;
    finished = true;
    if (listener !== null) {
      const current = listener;
      listener = null;
      try {
        doc.removeEventListener("DOMContentLoaded", current);
      } catch {
      }
    }
    if (timer !== null) {
      const handle = timer;
      timer = null;
      try {
        clearInterval(handle);
      } catch {
      }
    }
  };
  const attempt = () => {
    if (cancelled || finished) return true;
    let attached = false;
    try {
      attached = mount();
    } catch (error) {
      warn("mounting the cover failed; giving up", error);
      try {
        giveUp();
      } catch (giveUpError) {
        warn("give-up handler failed", giveUpError);
      }
      attached = true;
    }
    if (!attached) return false;
    stopWatching();
    return true;
  };
  if (attempt()) return () => {
    cancelled = true;
  };
  listener = () => {
    attempt();
  };
  try {
    doc.addEventListener("DOMContentLoaded", listener);
  } catch (error) {
    warn("could not listen for DOMContentLoaded", error);
  }
  const deadline = Date.now() + BODY_WAIT_TIMEOUT_MS;
  timer = setInterval(() => {
    if (cancelled) {
      stopWatching();
      return;
    }
    if (attempt()) return;
    if (Date.now() >= deadline) {
      stopWatching();
      try {
        giveUp();
      } catch (error) {
        warn("give-up handler failed", error);
      }
    }
  }, BODY_POLL_MS);
  return () => {
    cancelled = true;
    stopWatching();
  };
}
function mountOverlay(teardownSlot) {
  const doc = document;
  let host = null;
  let styleElement = null;
  let posters = [];
  let entry = null;
  let entryHandle = null;
  let controller = null;
  let cancelBodyWait = null;
  let onClick = null;
  let onKeyDown = null;
  let memoryIndex = null;
  let disposed = false;
  const readStoredIndex = () => {
    const raw = window.localStorage === void 0 ? null : window.localStorage.getItem(POSTER_INDEX_KEY);
    if (raw === null || raw === void 0) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const writeStoredIndex = (value) => {
    try {
      window.localStorage.setItem(POSTER_INDEX_KEY, String(value));
    } catch (error) {
      warn("could not persist the poster rotation index", error);
    }
  };
  const paint = (index) => {
    for (let i = 0; i < posters.length; i += 1) {
      try {
        if (i === index) posters[i].classList.add("is-on");
        else posters[i].classList.remove("is-on");
      } catch (error) {
        warn("could not switch the poster layer", error);
      }
    }
  };
  const advancePoster = () => {
    let stored = null;
    try {
      stored = readStoredIndex();
    } catch (error) {
      warn("could not read the poster rotation index", error);
      stored = null;
    }
    if (stored === null && memoryIndex !== null) stored = memoryIndex;
    const step = nextPosterIndex(() => stored);
    memoryIndex = step.store;
    paint(step.show);
    try {
      writeStoredIndex(step.store);
    } catch {
    }
    debug("showing poster #" + step.show + " (" + POSTER_FILES[step.show] + ")");
  };
  const cleanup = (note) => {
    if (disposed) return;
    disposed = true;
    const cancel = cancelBodyWait;
    cancelBodyWait = null;
    if (cancel !== null) {
      try {
        cancel();
      } catch (error) {
        warn("cancelling the body wait failed", error);
      }
    }
    if (controller !== null) {
      try {
        controller.dispose();
      } catch (error) {
        warn("disposing the controller failed", error);
      }
    }
    if (entry !== null && onClick !== null) {
      try {
        entry.removeEventListener("click", onClick);
      } catch (error) {
        warn("removing the entry click listener failed", error);
      }
    }
    if (onKeyDown !== null) {
      try {
        doc.removeEventListener("keydown", onKeyDown, true);
      } catch (error) {
        warn("removing the keydown listener failed", error);
      }
    }
    onClick = null;
    onKeyDown = null;
    if (entryHandle !== null) {
      const handle = entryHandle;
      entryHandle = null;
      try {
        handle.dispose();
      } catch (error) {
        warn("disposing the entry failed", error);
      }
    }
    if (styleElement !== null && styleElement.parentNode !== null) {
      try {
        styleElement.parentNode.removeChild(styleElement);
      } catch (error) {
        warn("removing the cover stylesheet failed", error);
      }
    }
    if (host !== null && host.parentNode !== null) {
      try {
        host.parentNode.removeChild(host);
      } catch (error) {
        warn("removing the overlay node failed", error);
      }
    }
    posters = [];
    entry = null;
    try {
      delete window.__HEI_POSTER__;
    } catch {
    }
    debug(note);
  };
  teardownSlot.current = () => cleanup("disposed");
  host = doc.createElement("div");
  host.id = OVERLAY_ELEMENT_ID;
  host.setAttribute("data-hei-poster-overlay", "");
  host.style.cssText = OVERLAY_STYLE;
  host.style.setProperty("display", "none");
  let rootNode = host;
  try {
    if (typeof host.attachShadow === "function") {
      rootNode = host.attachShadow({ mode: "open" });
    }
  } catch (error) {
    warn("attachShadow failed; falling back to a plain div", error);
    rootNode = host;
  }
  if (!(rootNode instanceof ShadowRoot)) host.setAttribute("class", DEGRADED_CLASS);
  styleElement = doc.createElement("style");
  styleElement.setAttribute("data-hei-poster", "cover-css");
  styleElement.textContent = COVER_CSS + "\n" + ENTRY_CSS;
  rootNode.appendChild(styleElement);
  const stage = doc.createElement("div");
  stage.setAttribute("class", "stage");
  rootNode.appendChild(stage);
  posters = POSTER_FILES.map((file, index) => {
    const img = doc.createElement("img");
    img.setAttribute("class", "poster" + (index === 0 ? " is-on" : ""));
    img.setAttribute("src", ASSET_BASE + file);
    img.setAttribute("alt", index === 0 ? "\u7F57\u5C0F\u9ED1\u6218\u8BB0\u6D77\u62A5 A" : "\u7F57\u5C0F\u9ED1\u6218\u8BB0\u6D77\u62A5 B");
    img.setAttribute("draggable", "false");
    img.setAttribute("decoding", "async");
    img.addEventListener("error", () => {
      warn("poster " + file + " failed to load; the paper background shows instead");
      try {
        img.style.setProperty("display", "none");
        img.setAttribute("aria-hidden", "true");
      } catch (error) {
        warn("could not hide the failed poster layer", error);
      }
    });
    stage.appendChild(img);
    return img;
  });
  entryHandle = createEntry({ doc });
  stage.appendChild(entryHandle.el);
  entry = entryHandle.el;
  const hostNode = host;
  const entryRef = entryHandle.el;
  const deps = {
    now: () => Date.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle),
    onVisibilityChange: (handler) => {
      doc.addEventListener("visibilitychange", handler);
      return () => doc.removeEventListener("visibilitychange", handler);
    },
    isHidden: () => {
      if (typeof doc.hidden === "boolean") return doc.hidden;
      return doc.visibilityState === "hidden";
    },
    isFocused: () => {
      try {
        return typeof doc.hasFocus === "function" ? doc.hasFocus() : true;
      } catch (error) {
        warn("could not read document focus", error);
        return true;
      }
    },
    // Feeding blur/focus is what lets the controller tell a tray restore from
    // Chromium merely reporting an occluded window as hidden.
    onFocusChange: (handler) => {
      const onFocus = () => handler(true);
      const onBlur = () => handler(false);
      window.addEventListener("focus", onFocus);
      window.addEventListener("blur", onBlur);
      return () => {
        window.removeEventListener("focus", onFocus);
        window.removeEventListener("blur", onBlur);
      };
    },
    show: () => {
      advancePoster();
      hostNode.style.setProperty("display", "block");
    },
    hide: () => {
      hostNode.style.setProperty("display", "none");
    },
    disabled: () => isDisabled(),
    log: debug
  };
  controller = new OverlayController(deps);
  const handleEntryClick = () => {
    if (controller !== null) controller.dismiss("click");
  };
  const handleEntryKey = (event) => {
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      if (controller !== null) controller.dismiss("click");
    }
  };
  const handleKeyDown = (event) => {
    if (event.key === "Escape" || event.keyCode === 27) {
      if (controller !== null) controller.dismiss("escape");
    }
  };
  try {
    onClick = handleEntryClick;
    onKeyDown = handleKeyDown;
    entryRef.addEventListener("click", handleEntryClick);
    entryRef.addEventListener("keydown", handleEntryKey);
    doc.addEventListener("keydown", handleKeyDown, true);
  } catch (error) {
    warn("could not attach the dismiss listeners", error);
  }
  const giveUp = (message) => {
    warn(message);
    cleanup("gave up: " + message);
  };
  const mount = () => {
    if (disposed) return true;
    const body = doc.body;
    if (body === null || body === void 0) return false;
    try {
      body.appendChild(hostNode);
      if (controller !== null) controller.start();
    } catch (error) {
      warn("attaching the cover failed; giving up", error);
      giveUp("the cover was removed because it could not be mounted completely");
      return true;
    }
    debug("mounted (css target: " + (rootNode instanceof ShadowRoot ? "shadow-root" : "light-dom") + ")");
    return true;
  };
  try {
    window.__HEI_POSTER__ = {
      pluginId: PACKAGE_ID,
      assetBase: ASSET_BASE,
      posters: POSTER_FILES.slice(),
      cssTarget: rootNode instanceof ShadowRoot ? "shadow-root" : "light-dom",
      host: hostNode,
      stage,
      entry: entryRef,
      controller,
      showPoster: (index) => paint(index),
      dismiss: (reason) => {
        if (controller !== null) controller.dismiss(reason === void 0 ? "timeout" : reason);
      }
    };
  } catch (error) {
    warn("could not publish window.__HEI_POSTER__", error);
  }
  try {
    cancelBodyWait = attachWhenBodyReady(doc, mount, () => {
      giveUp("document.body never appeared; the cover was not mounted");
    });
  } catch (error) {
    warn("could not start waiting for <body>", error);
  }
}
var inject = [];
function apply(ctx) {
  const teardownSlot = { current: null };
  try {
    if (ctx !== null && ctx !== void 0 && typeof ctx.effect === "function") {
      ctx.effect(() => () => {
        try {
          if (teardownSlot.current !== null) teardownSlot.current();
        } catch (error) {
          warn("teardown failed", error);
        }
      }, PACKAGE_ID + ": boot poster cover");
    } else {
      warn("ctx.effect is unavailable; the cover will not be cleaned up on unload");
    }
  } catch (error) {
    warn("could not register the ctx.effect teardown", error);
  }
  try {
    mountOverlay(teardownSlot);
  } catch (error) {
    warn("apply() failed; DSH keeps running without the boot cover", error);
  }
}
return module.exports;}});
