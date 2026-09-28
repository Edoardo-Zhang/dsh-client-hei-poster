/**
 * Unit tests for the overlay state machine.
 *
 * Runs with the built-in runner, no dependencies:
 *   node src/client/overlay.test.ts            (plain run)
 *   node --test src/client/overlay.test.ts     (test-runner run)
 *
 * The clock is virtual: time only moves when a test says so, so the 250 ms
 * arming window and the 30 s fail-safe are covered without waiting.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { AUTO_DISMISS_MS, INPUT_ARMING_MS, OverlayController } from "./overlay.ts";
import type { DismissReason, OverlayDeps } from "./overlay.ts";
import { MOTION_CSS, createMotion } from "./motion.ts";

interface FakeTimer {
  at: number;
  fn: () => void;
}

/** Virtual clock + recording DOM stand-in + the deps handed to the controller. */
class FakeHost {
  time = 0;
  hidden = false;
  showCalls = 0;
  hideCalls = 0;
  subscriptions = 0;
  unsubscriptions = 0;
  dismissReasons: DismissReason[] = [];
  logs: string[] = [];
  timers = new Map<number, FakeTimer>();
  handlers: Array<() => void> = [];
  focusHandlers: Array<(focused: boolean) => void> = [];
  focusSubscriptions = 0;
  focused = true;
  nextTimerId = 1;

  /** Number of timers still scheduled. */
  get liveTimers(): number {
    return this.timers.size;
  }

  deps(): OverlayDeps {
    return {
      now: () => this.time,
      setTimer: (fn, ms) => {
        const id = this.nextTimerId;
        this.nextTimerId += 1;
        this.timers.set(id, { at: this.time + ms, fn });
        return id;
      },
      clearTimer: (handle) => {
        this.timers.delete(handle as number);
      },
      onVisibilityChange: (handler) => {
        this.handlers.push(handler);
        this.subscriptions += 1;
        return () => {
          const index = this.handlers.indexOf(handler);
          if (index >= 0) this.handlers.splice(index, 1);
          this.unsubscriptions += 1;
        };
      },
      isHidden: () => this.hidden,
      isFocused: () => this.focused,
      onFocusChange: (handler) => {
        this.focusHandlers.push(handler);
        this.focusSubscriptions += 1;
        return () => {
          const index = this.focusHandlers.indexOf(handler);
          if (index >= 0) this.focusHandlers.splice(index, 1);
        };
      },
      show: () => { this.showCalls += 1; },
      hide: () => { this.hideCalls += 1; },
      log: (message) => { this.logs.push(message); },
    };
  }

  /** Run every timer that comes due within the next ms virtual milliseconds. */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let dueId = -1;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueAt = timer.at;
          dueId = id;
        }
      }
      if (dueId === -1) break;
      const due = this.timers.get(dueId);
      this.timers.delete(dueId);
      if (due === undefined) break;
      this.time = due.at;
      due.fn();
    }
    this.time = target;
  }

  /** Simulate a page visibility change and notify the subscribers. */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const handler of [...this.handlers]) handler();
  }

  /** Simulate a focus/blur and notify the focus subscribers. */
  setFocused(focused: boolean): void {
    this.focused = focused;
    for (const handler of [...this.focusHandlers]) handler(focused);
  }
}

function setup(disabled?: () => boolean): { host: FakeHost; controller: OverlayController } {
  const host = new FakeHost();
  const deps = host.deps();
  if (disabled !== undefined) deps.disabled = disabled;
  const controller = new OverlayController(deps);
  return { host, controller };
}

test("start() shows the cover immediately and subscribes exactly once", () => {
  const { host, controller } = setup();
  controller.start();
  assert.equal(host.showCalls, 1);
  assert.equal(controller.visible, true);
  assert.equal(host.subscriptions, 1);
  assert.equal(host.liveTimers, 1);
});

test("hidden -> visible transition re-shows the cover", () => {
  const { host, controller } = setup();
  controller.start();
  controller.dismiss("click");
  host.advance(INPUT_ARMING_MS);
  controller.dismiss("click");
  assert.equal(controller.visible, false);
  assert.equal(host.showCalls, 1);

  host.setHidden(true);
  host.setHidden(false);
  assert.equal(host.showCalls, 2);
  assert.equal(controller.visible, true);
});

test("visible -> visible noise never re-shows the cover", () => {
  const { host, controller } = setup();
  controller.start();
  host.advance(INPUT_ARMING_MS);
  controller.dismiss("escape");
  assert.equal(controller.visible, false);

  // Alt-tab that never hides the page, plus a repeated visibility event.
  host.setHidden(false);
  host.setHidden(false);
  assert.equal(host.showCalls, 1);
  assert.equal(controller.visible, false);
});

test("a click inside the arming window is ignored", () => {
  const { host, controller } = setup();
  controller.start();
  host.advance(INPUT_ARMING_MS - 1);
  controller.dismiss("click");
  assert.equal(controller.visible, true);
  assert.equal(host.hideCalls, 0);

  host.advance(1);
  controller.dismiss("click");
  assert.equal(controller.visible, false);
  assert.equal(host.hideCalls, 1);
});

test("Escape is never gated by the arming window", () => {
  const { host, controller } = setup();
  controller.start();
  controller.dismiss("escape");
  assert.equal(controller.visible, false);
  assert.equal(host.hideCalls, 1);
});

test("the fail-safe dismisses the cover after AUTO_DISMISS_MS", () => {
  const { host, controller } = setup();
  controller.start();
  host.advance(AUTO_DISMISS_MS - 1);
  assert.equal(controller.visible, true);
  host.advance(1);
  assert.equal(controller.visible, false);
  assert.equal(host.hideCalls, 1);
  assert.ok(host.logs.indexOf("dismiss(timeout)") >= 0);
});

test("the fail-safe is re-armed on every re-show", () => {
  const { host, controller } = setup();
  controller.start();
  host.advance(20_000);
  host.setHidden(true);
  host.setHidden(false);
  host.advance(AUTO_DISMISS_MS - 1);
  assert.equal(controller.visible, true);
  host.advance(1);
  assert.equal(controller.visible, false);
});

test("repeated show() keeps one timer and one subscription", () => {
  const { host, controller } = setup();
  controller.start();
  controller.show();
  controller.show();
  assert.equal(host.liveTimers, 1);
  assert.equal(host.subscriptions, 1);
  assert.equal(host.showCalls, 3);

  // The arming window restarts with the newest show().
  controller.dismiss("click");
  assert.equal(controller.visible, true);
  host.advance(INPUT_ARMING_MS);
  controller.dismiss("click");
  assert.equal(controller.visible, false);
  assert.equal(host.liveTimers, 0);
});

test("dispose() is idempotent and final", () => {
  const { host, controller } = setup();
  controller.start();
  assert.equal(host.liveTimers, 1);

  controller.dispose();
  controller.dispose();
  controller.dispose();

  assert.equal(controller.isDisposed, true);
  assert.equal(host.liveTimers, 0);
  assert.equal(host.unsubscriptions, 1);
  assert.equal(host.handlers.length, 0);
  assert.equal(host.hideCalls, 1);

  controller.show();
  assert.equal(host.showCalls, 1);
  assert.equal(controller.visible, false);

  host.setHidden(true);
  host.setHidden(false);
  assert.equal(host.showCalls, 1);
  host.advance(AUTO_DISMISS_MS * 2);
  assert.equal(host.hideCalls, 1);
});

test("dismiss() before start() and after dispose() are no-ops", () => {
  const { host, controller } = setup();
  controller.dismiss("click");
  controller.dismiss("timeout");
  assert.equal(host.hideCalls, 0);
  controller.start();
  controller.dispose();
  controller.dismiss("click");
  assert.equal(host.hideCalls, 1);
});

test("the disable switch suppresses start() entirely", () => {
  const { host, controller } = setup(() => true);
  controller.start();
  assert.equal(host.showCalls, 0);
  assert.equal(host.subscriptions, 0);
  assert.equal(host.liveTimers, 0);
  assert.equal(controller.visible, false);
});

test("the disable switch also blocks a later hidden -> visible re-show (M-3)", () => {
  let disabled = false;
  const { host, controller } = setup(() => disabled);

  controller.start();
  assert.equal(host.showCalls, 1);
  assert.equal(controller.visible, true);

  // The user flips the switch (console / localStorage / <html data-hei-off>)
  // and dismisses the cover that is on screen.
  disabled = true;
  host.advance(INPUT_ARMING_MS);
  controller.dismiss("click");
  assert.equal(controller.visible, false);

  // Tray restore: the cover must NOT come back.
  host.setHidden(true);
  host.setHidden(false);
  assert.equal(host.showCalls, 1, "show() must be suppressed by the disable switch");
  assert.equal(controller.visible, false);
  assert.equal(host.liveTimers, 0, "a suppressed show() must not arm the fail-safe");

  // ...and neither must a direct call from the debug handle.
  controller.show();
  assert.equal(host.showCalls, 1);
  assert.equal(controller.visible, false);
  assert.equal(host.liveTimers, 0);
});

test("show() honours the disable switch even without start() (M-3)", () => {
  const { host, controller } = setup(() => true);
  controller.show();
  assert.equal(controller.visible, false);
  assert.equal(host.showCalls, 0);
  assert.equal(host.liveTimers, 0);
  assert.ok(host.logs.some((line) => line.indexOf("show(): suppressed") === 0));
});

test("a disable switch that throws does not take show() down (M-3)", () => {
  const { host, controller } = setup(() => {
    throw new Error("storage exploded");
  });
  controller.start();
  assert.equal(host.showCalls, 1);
  assert.equal(controller.visible, true);
  assert.equal(host.liveTimers, 1);
});

test("start() twice is the same as start() once", () => {
  const { host, controller } = setup();
  controller.start();
  controller.start();
  assert.equal(host.showCalls, 1);
  assert.equal(host.subscriptions, 1);
  assert.equal(host.liveTimers, 1);
});
// ---------------------------------------------------------------------------
// Occlusion filter: Chromium reports a fully covered window as hidden too, and
// that must not be mistaken for the window having been sent to the tray.
// ---------------------------------------------------------------------------

test("a real hide re-shows the cover when the window comes back", () => {
  const { host, controller } = setup();
  controller.start();                 // show #1
  controller.dismiss("escape");       // the user closed the cover
  assert.equal(controller.visible, false);

  host.setHidden(true);               // window went away while still focused
  host.setHidden(false);              // ... and came back
  assert.equal(host.showCalls, 2);
  assert.equal(controller.visible, true);
});

test("occlusion does not re-show the cover", () => {
  const { host, controller } = setup();
  controller.start();
  controller.dismiss("escape");

  host.setFocused(false);             // the user clicked another window
  host.advance(2000);                 // ... which only later covered this one
  host.setHidden(true);
  host.setHidden(false);

  assert.equal(host.showCalls, 1, "the cover must stay away after an occlusion");
  assert.equal(controller.visible, false);
});

test("a blur landing together with hiding is still a real hide", () => {
  const { host, controller } = setup();
  controller.start();
  controller.dismiss("escape");

  host.setFocused(false);             // blur and hide arrive almost together
  host.advance(100);                  // well under OCCLUSION_BLUR_MS
  host.setHidden(true);
  host.setHidden(false);

  assert.equal(host.showCalls, 2);
});

test("regaining focus clears the occlusion marker", () => {
  const { host, controller } = setup();
  controller.start();
  controller.dismiss("escape");

  host.setFocused(false);
  host.advance(5000);                 // a long blurred-but-visible stretch
  host.setFocused(true);              // the user comes back to the window
  host.advance(5000);
  host.setHidden(true);               // only later does the window really go
  host.setHidden(false);

  assert.equal(host.showCalls, 2, "a later real hide must still re-show");
});

test("a blur that arrives while already hidden is not an occlusion signal", () => {
  const { host, controller } = setup();
  controller.start();
  controller.dismiss("escape");

  host.setHidden(true);
  host.setFocused(false);             // focus is lost as part of hiding
  host.advance(5000);
  host.setHidden(false);

  assert.equal(host.showCalls, 2);
});

test("without onFocusChange every hidden -> visible edge still re-shows", () => {
  const host = new FakeHost();
  const deps = host.deps();
  delete (deps as { onFocusChange?: unknown }).onFocusChange;
  const controller = new OverlayController(deps);
  controller.start();
  controller.dismiss("escape");

  host.setFocused(false);
  host.advance(5000);
  host.setHidden(true);
  host.setHidden(false);

  assert.equal(host.showCalls, 2, "the filter is opt-in; without it nothing changes");
});

test("dispose() releases the focus subscription too", () => {
  const { host, controller } = setup();
  controller.start();
  assert.equal(host.focusSubscriptions, 1);
  controller.dispose();
  assert.equal(host.focusHandlers.length, 0);
});
test("setRestoreOnReturn(false) makes the cover cold-start only", () => {
  const { host, controller } = setup();
  controller.start();
  controller.dismiss("escape");
  controller.setRestoreOnReturn(false);
  assert.equal(controller.willRestoreOnReturn, false);

  host.setHidden(true);               // even a genuine tray hide...
  host.setHidden(false);              // ...must not bring the cover back

  assert.equal(host.showCalls, 1);
  assert.equal(controller.visible, false);
});

test("setRestoreOnReturn(true) is the default and can be turned back on", () => {
  const { host, controller } = setup();
  controller.start();
  controller.dismiss("escape");

  controller.setRestoreOnReturn(false);
  host.setHidden(true);
  host.setHidden(false);
  assert.equal(host.showCalls, 1);

  controller.setRestoreOnReturn(true);
  host.setHidden(true);
  host.setHidden(false);
  assert.equal(host.showCalls, 2, "re-enabling restores the tray behaviour");
});

// ---------------------------------------------------------------------------
// The motion engine (src/client/motion.ts). The timeline itself needs a real
// browser and is checked by scripts/selfcheck-client.mjs; what is pinned down
// here is the contract the integration depends on: when the engine may animate
// at all, that seek() clamps instead of throwing, and that dispose() leaves the
// stage exactly as it found it.
// ---------------------------------------------------------------------------

/** Minimal classList stand-in - motion.ts only adds, removes and toggles. */
class FakeClassList {
  names = new Set<string>();

  add(...tokens: string[]): void {
    for (const token of tokens) this.names.add(token);
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) this.names.delete(token);
  }

  toggle(token: string, force?: boolean): boolean {
    const on = force === undefined ? !this.names.has(token) : force === true;
    if (on) this.names.add(token);
    else this.names.delete(token);
    return on;
  }

  contains(token: string): boolean {
    return this.names.has(token);
  }
}

/** Inline-style stand-in: motion.ts writes opacity/transform and reads neither. */
class FakeStyle {
  props = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.props.set(name, String(value));
  }

  removeProperty(name: string): string {
    const value = this.props.get(name) ?? "";
    this.props.delete(name);
    return value;
  }

  get(name: string): string {
    return this.props.get(name) ?? "";
  }

  get opacity(): string {
    return this.get("opacity");
  }

  set opacity(value: string) {
    this.setProperty("opacity", value);
  }

  get transform(): string {
    return this.get("transform");
  }

  set transform(value: string) {
    this.setProperty("transform", value);
  }
}

/** Element stand-in: createElement, appendChild, removeChild, classList, style. */
class FakeElement {
  tagName: string;
  classList = new FakeClassList();
  style = new FakeStyle();
  children: FakeElement[] = [];
  attributes = new Map<string, string>();
  parentNode: FakeElement | null = null;
  textContent = "";
  naturalWidth = 100;
  complete = true;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    if (child.parentNode === this) child.parentNode = null;
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    const value = this.attributes.get(name);
    return value === undefined ? null : value;
  }
}

/** Document stand-in: createElement, defaultView.performance, matchMedia. */
class FakeDocument {
  clock = 0;
  matchMediaMatches = false;
  defaultView = {
    performance: { now: () => this.clock },
    matchMedia: (query: string) => ({ matches: this.matchMediaMatches, media: query }),
  };

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

interface MotionRig {
  doc: FakeDocument;
  stage: FakeElement;
  layers: FakeElement[];
  logs: string[];
}

/** A stage, `count` poster layers and a clock the test moves by hand. */
function motionRig(options?: { count?: number; naturalWidth?: number; complete?: boolean }): MotionRig {
  const doc = new FakeDocument();
  const stage = doc.createElement("div");
  const layers: FakeElement[] = [];
  const count = options && options.count !== undefined ? options.count : 2;
  for (let i = 0; i < count; i += 1) {
    const layer = doc.createElement("img");
    layer.naturalWidth = options && options.naturalWidth !== undefined ? options.naturalWidth : 100;
    layer.complete = options && options.complete !== undefined ? options.complete : true;
    layers.push(layer);
  }
  return { doc, stage, layers, logs: [] };
}

/** Exactly the deps members motion.ts reads, over the stand-ins above. */
function motionDeps(rig: MotionRig, overrides?: { reducedMotion?: boolean; cycleMs?: number }) {
  return {
    doc: rig.doc as unknown as Document,
    stage: rig.stage as unknown as HTMLElement,
    layers: rig.layers as unknown as HTMLElement[],
    cycleMs: overrides ? overrides.cycleMs : undefined,
    reducedMotion: overrides ? overrides.reducedMotion : undefined,
    log: (message: string) => { rig.logs.push(message); },
  };
}

/** Number of stylesheet nodes the engine inserted into the stage. */
function styleCount(stage: FakeElement): number {
  return stage.children.filter((child) => child.tagName === "style").length;
}

test("motion: prefers-reduced-motion keeps the engine static", () => {
  const flagged = motionRig();
  const viaFlag = createMotion(motionDeps(flagged, { reducedMotion: true }));
  assert.equal(viaFlag.mode, "static");
  viaFlag.start(0);
  assert.equal(viaFlag.mode, "static");
  assert.equal(viaFlag.active, false);
  assert.equal(viaFlag.phase, 0);

  const media = motionRig();
  media.doc.matchMediaMatches = true;
  const viaMedia = createMotion(motionDeps(media));
  assert.equal(viaMedia.mode, "static");
  assert.equal(media.stage.classList.contains("is-motion"), false);
});

test("motion: fewer than two layers keeps the engine static", () => {
  const rig = motionRig({ count: 1 });
  const handle = createMotion(motionDeps(rig));
  assert.equal(handle.mode, "static");
  handle.start(0);
  assert.equal(handle.mode, "static");
  assert.equal(rig.stage.classList.contains("is-motion"), false);
});

test("motion: an unsettled layer keeps the engine static until start() rechecks", () => {
  const broken = motionRig({ naturalWidth: 0 });
  const absent = createMotion(motionDeps(broken));
  assert.equal(absent.mode, "static");

  const pending = motionRig({ complete: false });
  const late = createMotion(motionDeps(pending));
  assert.equal(late.mode, "static", "a layer that is still loading must not animate");
  late.start(0);
  assert.equal(late.mode, "static");
  assert.equal(late.active, false);

  // Once the images settle, the very same handle may animate: the readiness flag
  // is re-read by start(), which is what the plugin hand-over relies on.
  pending.layers[0].complete = true;
  pending.layers[1].complete = true;
  late.start(0);
  assert.equal(late.mode, "animated");
  assert.equal(late.active, true);
});

test("motion: seek() clamps to 0..1, maps NaN to 0 and never throws", () => {
  const rig = motionRig();
  const handle = createMotion(motionDeps(rig));
  handle.start(0);
  assert.equal(handle.mode, "animated");

  handle.seek(-1);
  assert.equal(handle.phase, 0);
  assert.equal(rig.stage.style.get("--hei-motion-delay"), "-0ms");
  assert.equal(rig.stage.style.get("--hei-motion-play-state"), "paused");

  handle.seek(2);
  assert.equal(handle.phase, 1);
  assert.equal(rig.stage.style.get("--hei-motion-delay"), "-12000ms");

  handle.seek(Number.NaN);
  assert.equal(handle.phase, 0);

  // A static engine ignores the frame, but it must not throw either.
  const still = createMotion(motionDeps(motionRig(), { reducedMotion: true }));
  assert.doesNotThrow(() => still.seek(0.5));
  assert.equal(still.mode, "static");
});

test("motion: start() twice adds no second stylesheet", () => {
  const rig = motionRig();
  const handle = createMotion(motionDeps(rig));
  handle.start(0);
  assert.equal(styleCount(rig.stage), 1);
  assert.equal(rig.stage.classList.contains("is-motion"), true);
  assert.equal(rig.stage.classList.contains("is-reversed"), false);
  assert.equal(rig.layers[0].classList.contains("hei-motion-a"), true);
  assert.equal(rig.layers[1].classList.contains("hei-motion-b"), true);

  handle.start(0);
  handle.start(0);
  assert.equal(styleCount(rig.stage), 1);

  handle.start(1);
  assert.equal(styleCount(rig.stage), 1);
  assert.equal(rig.stage.classList.contains("is-reversed"), true, "start(1) swaps the roles");

  handle.start(0);
  assert.equal(styleCount(rig.stage), 1);
  assert.equal(rig.stage.classList.contains("is-reversed"), false);
});

test("motion: stop() pauses and keeps the phase", () => {
  const rig = motionRig();
  const handle = createMotion(motionDeps(rig));
  handle.start(0);
  assert.equal(handle.active, true);

  rig.doc.clock = 3000;
  handle.stop();
  assert.equal(handle.active, false);
  assert.ok(Math.abs(handle.phase - 0.25) < 0.001, "phase=" + handle.phase);
  assert.equal(rig.stage.style.get("--hei-motion-play-state"), "paused");
  assert.equal(handle.mode, "animated", "paused is not the same as degraded");

  rig.doc.clock = 9000;
  assert.ok(Math.abs(handle.phase - 0.25) < 0.001, "phase=" + handle.phase);
});

test("motion: dispose() is idempotent and leaves the stage as it found it", () => {
  const rig = motionRig();
  const handle = createMotion(motionDeps(rig));
  handle.start(0);
  handle.seek(0.5);
  assert.equal(styleCount(rig.stage), 1);
  assert.notEqual(rig.layers[0].style.opacity, "");

  handle.dispose();
  assert.doesNotThrow(() => handle.dispose());
  assert.equal(styleCount(rig.stage), 0, "the engine stylesheet must be gone");
  assert.equal(rig.stage.children.length, 0);
  assert.equal(rig.stage.classList.contains("is-motion"), false);
  assert.equal(rig.stage.classList.contains("is-reversed"), false);
  assert.equal(rig.stage.style.get("--hei-motion-duration"), "");
  assert.equal(rig.stage.style.get("--hei-motion-delay"), "");
  assert.equal(rig.stage.style.get("--hei-motion-play-state"), "");
  assert.equal(rig.layers[0].classList.contains("hei-motion-a"), false);
  assert.equal(rig.layers[1].classList.contains("hei-motion-b"), false);
  assert.equal(rig.layers[0].style.opacity, "");
  assert.equal(rig.layers[0].style.transform, "");
  assert.equal(rig.layers[1].style.opacity, "");
  assert.equal(rig.layers[1].style.transform, "");
  assert.equal(handle.mode, "static");
  assert.equal(handle.active, false);

  assert.doesNotThrow(() => handle.seek(0.4));
  assert.doesNotThrow(() => handle.start(0));
  assert.equal(handle.mode, "static");
});

test("motion: MOTION_CSS carries the display rule the integration relies on", () => {
  assert.equal(typeof MOTION_CSS, "string");
  assert.ok(MOTION_CSS.length > 0);
  assert.ok(MOTION_CSS.indexOf(".poster") >= 0, "MOTION_CSS must mention .poster");
  assert.ok(MOTION_CSS.indexOf(".stage.is-motion .poster{display:block}") >= 0);
  assert.ok(MOTION_CSS.indexOf("@keyframes hei-poster-a") >= 0);
  assert.ok(MOTION_CSS.indexOf("@keyframes hei-poster-b") >= 0);
});
