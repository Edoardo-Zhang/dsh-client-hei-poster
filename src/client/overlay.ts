/**
 * hei-poster — visibility state machine for the full-screen boot cover.
 *
 * Deliberately free of React and of DOM specifics: every side effect arrives
 * through {@link OverlayDeps}, so the behaviour below is unit-testable with a
 * fake clock and without a browser (see overlay.test.ts).
 *
 * Behaviour contract:
 *  1. start() shows the cover immediately.
 *  2. Afterwards the cover comes back only on a real hidden -> visible page
 *     transition (tray/window restore). A focus change, or any visibility event
 *     while the page is visible, is ignored.
 *  3. dismiss("click" | "escape" | "timeout") hides it.
 *  4. A click is ignored for {@link INPUT_ARMING_MS} after each show(), so the very
 *     click that restores the window cannot close the cover. Escape and the
 *     timeout are never gated.
 *  5. Every show() (re)arms a {@link AUTO_DISMISS_MS} fail-safe timer, so a broken
 *     click path can never lock the user out of the application.
 *  6. show() is idempotent: one timer, one subscription, no duplicates.
 *  7. dispose() is idempotent and final: timers cleared, subscription cancelled,
 *     later show() calls have no effect.
 *  8. The disable switch is evaluated on every show(), not just in start(): a run
 *     that was fine at boot must also stay off after a tray restore (M-3).
 */

/** Why the cover went away. */
export type DismissReason = "click" | "escape" | "timeout";

/** Injected side effects. All of them are replaced in tests. */
export interface OverlayDeps {
  /** Monotonic-enough clock in milliseconds. */
  now(): number;
  /** Schedule `fn` after `ms`; the handle is opaque to this class. */
  setTimer(fn: () => void, ms: number): unknown;
  /** Cancel a handle returned by {@link OverlayDeps.setTimer}. */
  clearTimer(handle: unknown): void;
  /** Subscribe to page visibility changes; returns the unsubscribe function. */
  onVisibilityChange(handler: () => void): () => void;
  /** Read the current "page is hidden" state (document.hidden). */
  isHidden(): boolean;
  /**
   * Page focus (document.hasFocus()). Used to tell a REAL hide — tray or
   * minimize, where the window was focused right up to the moment it vanished —
   * from Chromium reporting a merely OCCLUDED window as hidden.
   */
  isFocused?(): boolean;
  /**
   * Subscribe to focus/blur; the handler receives the new focused state.
   * Without it the occlusion filter is skipped and every hidden -> visible
   * edge re-shows the cover (the pre-fix behaviour).
   */
  onFocusChange?(handler: (focused: boolean) => void): () => void;
  /** Make the cover visible. */
  show(): void;
  /** Make the cover invisible. */
  hide(): void;
  /**
   * Optional kill switch, consulted by start() *and* by every show(); true means
   * "leave the cover hidden". It may be evaluated at any time.
   */
  disabled?(): boolean;
  /** Optional diagnostics sink. */
  log?(message: string): void;
}

/** Clicks arriving within this window after a show() are ignored. */
export const INPUT_ARMING_MS = 250;

/** Hard fail-safe: the cover closes itself this long after every show(). */
export const AUTO_DISMISS_MS = 30_000;

/**
 * Grace window between losing focus and going hidden, below which the hide
 * counts as real (tray / minimize) rather than Chromium occlusion.
 *
 * Tray: clicking the close button calls win.hide() synchronously, so blur and
 * hidden reach the renderer essentially together — well under this.
 * Minimize: same.
 * Occlusion: the user clicks another window first, and Chromium only reports the
 * covered window as hidden once its occlusion tracker notices — that latency is
 * what this threshold separates.
 *
 * Tuned tight on purpose: an already-maximized window behind this one covers it
 * within a few tens of milliseconds of the click, so a loose threshold would
 * mistake that for a tray restore every time.
 *
 * This is a heuristic, not a guarantee. `restoreOnReturn` (below) is the escape
 * hatch when it guesses wrong.
 */
export const OCCLUSION_BLUR_MS = 120;

export class OverlayController {
  private deps: OverlayDeps;
  private showing = false;
  private shownAt = Number.NEGATIVE_INFINITY;
  private timerActive = false;
  private timer: unknown = null;
  private unsubscribe: (() => void) | null = null;
  private wasHidden = false;
  private started = false;
  private disposed = false;
  /** When the page last blurred while still visible; null when focused. */
  private blurredWhileVisibleAt: number | null = null;
  /** Whether the pending hidden -> visible edge should re-show the cover. */
  private restoreArmed = false;
  private unsubscribeFocus: (() => void) | null = null;
  /**
   * Whether a real hidden -> visible edge re-shows the cover. Turned off by
   * setRestoreOnReturn(false), which leaves the cover cold-start-only.
   */
  private restoreOnReturn = true;

  constructor(deps: OverlayDeps) {
    this.deps = deps;
  }

  /** Whether the cover is currently on screen. */
  get visible(): boolean {
    return this.showing;
  }

  /** Whether {@link OverlayController.dispose} already ran. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Show the cover now and start watching for hidden -> visible transitions.
   * Safe to call more than once; only the first call has an effect.
   */
  start(): void {
    if (this.disposed || this.started) return;
    this.started = true;

    // Checked here only to skip a pointless subscription; show() checks it too,
    // so the switch keeps working after the window comes back from the tray.
    if (this.isDisabled()) {
      this.log("start(): suppressed by the disable flag; the cover stays hidden");
      return;
    }

    try {
      this.wasHidden = this.deps.isHidden();
      this.unsubscribe = this.deps.onVisibilityChange(() => this.handleVisibilityChange());
    } catch (error) {
      // A missing visibility API only costs the "show again on restore" feature.
      this.log("start(): visibility subscription failed: " + describe(error));
      this.unsubscribe = null;
      this.wasHidden = false;
    }

    // Occlusion filter. Without this subscription every hidden -> visible edge
    // re-shows the cover, which makes merely covering the window with another
    // one look like a tray restore.
    const onFocusChange = this.deps.onFocusChange;
    if (onFocusChange !== undefined) {
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
  show(): void {
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
  dismiss(reason: DismissReason): void {
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
  dispose(): void {
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

  private handleVisibilityChange(): void {
    if (this.disposed) return;
    const hidden = this.deps.isHidden();
    const wasHidden = this.wasHidden;
    this.wasHidden = hidden;

    // Going hidden: decide NOW whether coming back should re-show the cover.
    // Chromium reports a fully occluded window as hidden too, and that must not
    // be mistaken for the window having been sent to the tray.
    if (!wasHidden && hidden) {
      const blurredAt = this.blurredWhileVisibleAt;
      const blurDelta = blurredAt === null ? null : this.deps.now() - blurredAt;
      this.restoreArmed = !this.lookedOccluded();
      // Deliberately diagnosable: this line is the evidence when the heuristic
      // guesses wrong. blurDelta "none" = the window never blurred first.
      this.log(
        "page hidden; blurDelta=" + (blurDelta === null ? "none" : blurDelta + "ms") +
          "; focused=" + this.isFocused() +
          "; re-showOnReturn=" + (this.restoreArmed && this.restoreOnReturn),
      );
      return;
    }

    // Only the hidden -> visible edge re-shows the cover. Visible -> visible
    // events (alt-tab that never unloaded the page, focus changes) are ignored.
    if (wasHidden && !hidden) {
      if (!this.restoreOnReturn) {
        this.log("visible again; restore-on-return is switched off");
        return;
      }
      if (!this.restoreArmed) {
        this.log("visible again, but the hide looked like occlusion; cover stays away");
        return;
      }
      this.log("page became visible again");
      this.show();
    }
  }

  /**
   * Turn the "show again when the window comes back" behaviour on or off.
   *
   * Off leaves the cover cold-start-only. That is the only setting where
   * occlusion is GUARANTEED never to bring it back, so it is the escape hatch
   * when the heuristic guesses wrong on this machine.
   */
  setRestoreOnReturn(enabled: boolean): void {
    this.restoreOnReturn = enabled === true;
    this.log("restoreOnReturn = " + this.restoreOnReturn);
  }

  /** Whether a real hidden -> visible edge would re-show the cover. */
  get willRestoreOnReturn(): boolean {
    return this.restoreOnReturn;
  }

  /** Read page focus defensively; a missing or throwing probe reports focused. */
  private isFocused(): boolean {
    const focused = this.deps.isFocused;
    if (focused === undefined) return true;
    try {
      return focused() === true;
    } catch (error) {
      this.log("isFocused() failed: " + describe(error));
      return true;
    }
  }

  /**
   * True when the page sat blurred-but-visible long enough before going hidden
   * that Chromium occlusion is the likely reason (see OCCLUSION_BLUR_MS).
   */
  private lookedOccluded(): boolean {
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
  private handleFocusChange(focused: boolean): void {
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
    // A blur that arrives together with hiding is not an occlusion signal.
    this.blurredWhileVisibleAt = hidden ? null : this.deps.now();
  }

  /** Evaluate the optional kill switch; a broken one must not break show(). */
  private isDisabled(): boolean {
    const disabled = this.deps.disabled;
    if (disabled === undefined) return false;
    try {
      return disabled() === true;
    } catch (error) {
      this.log("disabled() threw: " + describe(error));
      return false;
    }
  }

  private clearAutoDismiss(): void {
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

  private log(message: string): void {
    try {
      this.deps.log?.(message);
    } catch {
      // Diagnostics must never break the state machine.
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
