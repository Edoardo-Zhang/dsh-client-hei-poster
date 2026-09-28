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
