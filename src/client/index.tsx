/**
 * dsh-client-hei-poster — browser half.
 *
 * Boot cover: a full-screen poster that hides the DSH UI on every launch and
 * again whenever the window comes back from the tray. Two posters alternate on
 * every appearance. The cover is dismissed ONLY by the chat-window control in
 * the bottom-right corner; clicking the poster itself does nothing. Escape and a
 * 30s fail-safe also close it, so a broken hot zone can never lock the user out.
 *
 * Hard guarantees, carried over from the reviewed predecessor plugin:
 *   - everything happens inside one try/catch — a failure only warns;
 *   - inject stays empty on purpose: this half touches the DOM and nothing else,
 *     so it cannot hit "cannot get property X without inject";
 *   - the ctx.effect() teardown is registered before the first side effect, so a
 *     throw half-way through apply() still leaves the host a disposer;
 *   - <html> is never written: the host theme paints <body> opaque already, and an
 *     inline <html> background would outlive the cover and blank the window under
 *     macOS vibrancy;
 *   - our CSS goes into the shadow root, never into document.head, so it cannot
 *     restyle the host UI.
 */

import { OverlayController } from './overlay'
import type { DismissReason, OverlayDeps } from './overlay'
import { ENTRY_CSS, createEntry } from './entry'
import type { EntryHandle } from './entry'

/** Plugin id: must match package.json, cordis.patch.yml and src/index.js. */
const PACKAGE_ID = 'dsh-client-hei-poster'
/** Where the host half serves the media. */
const ASSET_BASE = '/plugins/' + PACKAGE_ID + '/assets/'
/** Poster files, in rotation order. */
const POSTER_FILES = ['poster-a.png', 'poster-b.png']
/** localStorage key holding the index of the poster that was shown LAST. */
const POSTER_INDEX_KEY = 'hei.posterIndex'
/** Id of the overlay node; also the handle used by the manual check recipe. */
const OVERLAY_ELEMENT_ID = 'hei-poster-overlay'
/** localStorage key that turns the cover off for good ("1" = off). */
const OFF_STORAGE_KEY = 'hei.noPoster'
/** <html> attribute that turns the cover off for good. */
const OFF_ATTRIBUTE = 'data-hei-off'
/** Class added on the degraded (no attachShadow) path. */
const DEGRADED_CLASS = 'hei-poster-root'
/** Stop waiting for <body> after this long. */
const BODY_WAIT_TIMEOUT_MS = 10_000
/** Poll period while waiting for <body>. */
const BODY_POLL_MS = 250
/**
 * Overlay geometry. Kept in JS on purpose. The background is the posters' own
 * paper tone, so a poster that fails to load still looks deliberate rather than
 * like a broken blank screen.
 */
const OVERLAY_STYLE =
  'position:fixed;inset:0;top:0;right:0;bottom:0;left:0;z-index:2000;display:block;' +
  'background:linear-gradient(160deg,#f2ece4 0%,#e6dfd6 55%,#d8d0c6 100%);'

/**
 * Everything inside the shadow root that is NOT owned by the entry module.
 * No external stylesheet, no framework. The entry's own rules live in entry.ts
 * (ENTRY_CSS) so a different sprite design stays self-contained.
 */
const COVER_CSS = [
  ':host{all:initial}',
  '.stage{position:absolute;inset:0;overflow:hidden}',
  '.poster{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center;display:none;user-select:none;-webkit-user-drag:none}',
  '.poster.is-on{display:block}',
].join('\n')

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Never throws: the cover is cosmetic, DSH startup is not. */
function warn(message: string, error?: unknown): void {
  try {
    if (error === undefined) console.warn('[' + PACKAGE_ID + '] ' + message)
    else console.warn('[' + PACKAGE_ID + '] ' + message + ': ' + describeError(error))
  } catch {
    // console itself is gone; nothing left to do.
  }
}

/** Debug channel: visible only with the console level set to "debug". */
function debug(message: string): void {
  try {
    console.debug('[' + PACKAGE_ID + '] ' + message)
  } catch {
    // ignore
  }
}

/** Read a boolean flag from the query string ("?name=1"). */
function searchHasFlag(name: string): boolean {
  try {
    const search = String(window.location?.search ?? '')
    if (search.indexOf(name + '=1') >= 0) return true
    return new URLSearchParams(search).get(name) === '1'
  } catch {
    return false
  }
}

/**
 * Kill switch. Any one of these four sources turns the cover off, and each one is
 * probed inside its own try/catch: reading storage or <html> can throw.
 *
 *  1. window.__HEI_POSTER_DISABLE__ truthy      (console, this session)
 *  2. localStorage["hei.noPoster"] === "1"      (console, permanent)
 *  3. <html data-hei-off>                       (devtools, permanent)
 *  4. ?noPoster=1                               (browser build only - an Electron
 *     window cannot be handed a query string, hence 1-3 above)
 */
function isDisabled(): boolean {
  try {
    if (Boolean((window as any).__HEI_POSTER_DISABLE__)) return true
  } catch {
    // ignore
  }
  try {
    const stored = window.localStorage === undefined ? null : window.localStorage.getItem(OFF_STORAGE_KEY)
    if (stored === '1') return true
  } catch {
    // Storage can be blocked (private mode, sandboxed frame); treat it as unset.
  }
  try {
    if (document.documentElement.hasAttribute(OFF_ATTRIBUTE)) return true
  } catch {
    // ignore
  }
  return searchHasFlag('noPoster')
}

/**
 * Index of the poster the NEXT appearance should show, plus the index to persist.
 * The stored value is the one shown LAST, so a fresh profile starts on poster A
 * and every later appearance advances by one.
 */
function nextPosterIndex(readStored: () => number | null): { show: number; store: number } {
  let last: number | null = null
  try {
    last = readStored()
  } catch {
    last = null
  }
  if (last === null || !Number.isFinite(last) || last < 0) return { show: 0, store: 0 }
  const show = (Math.trunc(last) + 1) % POSTER_FILES.length
  return { show, store: show }
}

/**
 * Wait for <body> (the shell may still be booting), then run `mount`.
 * Gives up after BODY_WAIT_TIMEOUT_MS and calls `giveUp` instead of spinning.
 *
 * @returns a cancel function; safe to call at any time, any number of times.
 */
function attachWhenBodyReady(doc: Document, mount: () => boolean, giveUp: () => void): () => void {
  let cancelled = false
  let finished = false
  let timer: unknown = null
  let listener: (() => void) | null = null

  const stopWatching = (): void => {
    if (finished) return
    finished = true
    if (listener !== null) {
      const current = listener
      listener = null
      try {
        doc.removeEventListener('DOMContentLoaded', current)
      } catch {
        // ignore
      }
    }
    if (timer !== null) {
      const handle = timer
      timer = null
      try {
        clearInterval(handle as number)
      } catch {
        // ignore
      }
    }
  }

  const attempt = (): boolean => {
    if (cancelled || finished) return true
    let attached = false
    try {
      attached = mount()
    } catch (error) {
      // "mount threw" is not "mount succeeded". Undo whatever the failure left
      // behind and stop retrying, so no undismissable screen stays on top.
      warn('mounting the cover failed; giving up', error)
      try {
        giveUp()
      } catch (giveUpError) {
        warn('give-up handler failed', giveUpError)
      }
      attached = true
    }
    if (!attached) return false
    stopWatching()
    return true
  }

  if (attempt()) return () => { cancelled = true }

  listener = () => {
    attempt()
  }
  try {
    doc.addEventListener('DOMContentLoaded', listener)
  } catch (error) {
    warn('could not listen for DOMContentLoaded', error)
  }
  const deadline = Date.now() + BODY_WAIT_TIMEOUT_MS
  timer = setInterval(() => {
    if (cancelled) {
      stopWatching()
      return
    }
    if (attempt()) return
    if (Date.now() >= deadline) {
      stopWatching()
      try {
        giveUp()
      } catch (error) {
        warn('give-up handler failed', error)
      }
    }
  }, BODY_POLL_MS)

  return () => {
    cancelled = true
    stopWatching()
  }
}

/** Everything apply() does, so a single try/catch can contain all of it. */
function mountOverlay(teardownSlot: { current: (() => void) | null }): void {
  const doc = document

  // Handles for every side effect. Each stays null until that step runs, so the
  // teardown below is always safe to call, even if a step in between threw.
  let host: HTMLElement | null = null
  let styleElement: HTMLStyleElement | null = null
  let posters: HTMLImageElement[] = []
  let entry: HTMLElement | null = null
  let entryHandle: EntryHandle | null = null
  let controller: OverlayController | null = null
  let cancelBodyWait: (() => void) | null = null
  let onClick: (() => void) | null = null
  let onKeyDown: ((event: KeyboardEvent) => void) | null = null
  let memoryIndex: number | null = null
  let disposed = false

  /** Read the persisted index; storage can be blocked, so callers guard it. */
  const readStoredIndex = (): number | null => {
    const raw = window.localStorage === undefined ? null : window.localStorage.getItem(POSTER_INDEX_KEY)
    if (raw === null || raw === undefined) return null
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : null
  }

  const writeStoredIndex = (value: number): void => {
    try {
      window.localStorage.setItem(POSTER_INDEX_KEY, String(value))
    } catch (error) {
      warn('could not persist the poster rotation index', error)
    }
  }

  /** Paint the given poster and hide the other one. No reload, no flash. */
  const paint = (index: number): void => {
    for (let i = 0; i < posters.length; i += 1) {
      try {
        if (i === index) posters[i].classList.add('is-on')
        else posters[i].classList.remove('is-on')
      } catch (error) {
        warn('could not switch the poster layer', error)
      }
    }
  }

  /**
   * Advance the rotation. Called on every show(), so a tray restore swaps the
   * poster just like a cold start does. Falls back to an in-memory counter when
   * storage is unavailable, so the cover still alternates within one session.
   */
  const advancePoster = (): void => {
    let stored: number | null = null
    try {
      stored = readStoredIndex()
    } catch (error) {
      warn('could not read the poster rotation index', error)
      stored = null
    }
    if (stored === null && memoryIndex !== null) stored = memoryIndex
    const step = nextPosterIndex(() => stored)
    memoryIndex = step.store
    paint(step.show)
    try {
      writeStoredIndex(step.store)
    } catch {
      // writeStoredIndex already warns
    }
    debug('showing poster #' + step.show + ' (' + POSTER_FILES[step.show] + ')')
  }

  const cleanup = (note: string): void => {
    if (disposed) return
    disposed = true

    const cancel = cancelBodyWait
    cancelBodyWait = null
    if (cancel !== null) {
      try {
        cancel()
      } catch (error) {
        warn('cancelling the body wait failed', error)
      }
    }
    if (controller !== null) {
      try {
        controller.dispose()
      } catch (error) {
        warn('disposing the controller failed', error)
      }
    }
    if (entry !== null && onClick !== null) {
      try {
        entry.removeEventListener('click', onClick)
      } catch (error) {
        warn('removing the entry click listener failed', error)
      }
    }
    if (onKeyDown !== null) {
      try {
        doc.removeEventListener('keydown', onKeyDown, true)
      } catch (error) {
        warn('removing the keydown listener failed', error)
      }
    }
    onClick = null
    onKeyDown = null
    if (entryHandle !== null) {
      const handle = entryHandle
      entryHandle = null
      try {
        handle.dispose()
      } catch (error) {
        warn('disposing the entry failed', error)
      }
    }
    if (styleElement !== null && styleElement.parentNode !== null) {
      try {
        styleElement.parentNode.removeChild(styleElement)
      } catch (error) {
        warn('removing the cover stylesheet failed', error)
      }
    }
    if (host !== null && host.parentNode !== null) {
      try {
        host.parentNode.removeChild(host)
      } catch (error) {
        warn('removing the overlay node failed', error)
      }
    }
    posters = []
    entry = null
    try {
      delete (window as any).__HEI_POSTER__
    } catch {
      // ignore
    }
    debug(note)
  }

  // Register the teardown *before* the first side effect. Everything below may
  // throw; none of it can leave an uncleanable node behind.
  teardownSlot.current = () => cleanup('disposed')

  // 1) Overlay node + shadow root.
  //    <html> is deliberately left alone (see the header comment).
  host = doc.createElement('div')
  host.id = OVERLAY_ELEMENT_ID
  host.setAttribute('data-hei-poster-overlay', '')
  host.style.cssText = OVERLAY_STYLE
  // Start hidden; the controller shows it, so a disabled start() leaves no flash.
  host.style.setProperty('display', 'none')

  let rootNode: HTMLElement | ShadowRoot = host
  try {
    if (typeof host.attachShadow === 'function') {
      rootNode = host.attachShadow({ mode: 'open' })
    }
  } catch (error) {
    warn('attachShadow failed; falling back to a plain div', error)
    rootNode = host
  }
  if (!(rootNode instanceof ShadowRoot)) host.setAttribute('class', DEGRADED_CLASS)

  styleElement = doc.createElement('style')
  styleElement.setAttribute('data-hei-poster', 'cover-css')
  styleElement.textContent = COVER_CSS + '\n' + ENTRY_CSS
  rootNode.appendChild(styleElement)

  const stage = doc.createElement('div')
  stage.setAttribute('class', 'stage')
  rootNode.appendChild(stage)

  // 2) The poster layers. Both are created up front so switching never flashes.
  posters = POSTER_FILES.map((file, index) => {
    const img = doc.createElement('img')
    img.setAttribute('class', 'poster' + (index === 0 ? ' is-on' : ''))
    img.setAttribute('src', ASSET_BASE + file)
    img.setAttribute('alt', index === 0 ? '罗小黑战记海报 A' : '罗小黑战记海报 B')
    img.setAttribute('draggable', 'false')
    img.setAttribute('decoding', 'async')
    img.addEventListener('error', () => {
      // Degrade cleanly: hide this layer so a 404 leaves the paper-tone background
      // and the entry control, never a broken-image glyph or stray alt text.
      warn('poster ' + file + ' failed to load; the paper background shows instead')
      try {
        img.style.setProperty('display', 'none')
        img.setAttribute('aria-hidden', 'true')
      } catch (error) {
        warn('could not hide the failed poster layer', error)
      }
    })
    stage.appendChild(img)
    return img
  })

  // 3) The dream entrance. The ONLY clickable element in the cover.
  //    The look lives in entry.ts behind a small interface, so an alternative
  //    sprite design can be swapped in without touching this file.
  entryHandle = createEntry({ doc })
  stage.appendChild(entryHandle.el)
  entry = entryHandle.el

  const hostNode = host
  const entryRef = entryHandle.el

  // 4) Show/hide state machine. Every dependency is real DOM here.
  const deps: OverlayDeps = {
    now: () => Date.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
    onVisibilityChange: (handler) => {
      doc.addEventListener('visibilitychange', handler)
      return () => doc.removeEventListener('visibilitychange', handler)
    },
    isHidden: () => {
      if (typeof doc.hidden === 'boolean') return doc.hidden
      return doc.visibilityState === 'hidden'
    },
    show: () => {
      advancePoster()
      hostNode.style.setProperty('display', 'block')
    },
    hide: () => {
      hostNode.style.setProperty('display', 'none')
    },
    disabled: () => isDisabled(),
    log: debug,
  }
  controller = new OverlayController(deps)

  // The ONLY dismiss-by-pointer path: a click on the chat-window control.
  // Everything else in the cover is inert, so a stray click cannot dismiss it.
  const handleEntryClick = (): void => {
    if (controller !== null) controller.dismiss('click')
  }
  const handleEntryKey = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault()
      if (controller !== null) controller.dismiss('click')
    }
  }
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' || event.keyCode === 27) {
      if (controller !== null) controller.dismiss('escape')
    }
  }
  try {
    onClick = handleEntryClick
    onKeyDown = handleKeyDown
    entryRef.addEventListener('click', handleEntryClick)
    entryRef.addEventListener('keydown', handleEntryKey)
    doc.addEventListener('keydown', handleKeyDown, true)
  } catch (error) {
    warn('could not attach the dismiss listeners', error)
  }

  /** Undo everything; used by a failed mount and by the <body> wait timeout. */
  const giveUp = (message: string): void => {
    warn(message)
    cleanup('gave up: ' + message)
  }

  /** Attach the cover to <body>, then start watching. */
  const mount = (): boolean => {
    if (disposed) return true
    const body = doc.body
    if (body === null || body === undefined) return false

    // A cover that is on screen but has no working dismiss path - and no fail-safe
    // timer - is worse than no cover, so any failure here undoes everything.
    try {
      body.appendChild(hostNode)
      if (controller !== null) controller.start()
    } catch (error) {
      warn('attaching the cover failed; giving up', error)
      giveUp('the cover was removed because it could not be mounted completely')
      return true
    }
    debug('mounted (css target: ' + (rootNode instanceof ShadowRoot ? 'shadow-root' : 'light-dom') + ')')
    return true
  }

  // 5) Handles stay on the node so the cover can be driven from the console.
  try {
    (window as any).__HEI_POSTER__ = {
      pluginId: PACKAGE_ID,
      assetBase: ASSET_BASE,
      posters: POSTER_FILES.slice(),
      cssTarget: rootNode instanceof ShadowRoot ? 'shadow-root' : 'light-dom',
      host: hostNode,
      stage,
      entry: entryRef,
      controller,
      showPoster: (index: number) => paint(index),
      dismiss: (reason: DismissReason) => {
        if (controller !== null) controller.dismiss(reason === undefined ? 'timeout' : reason)
      },
    }
  } catch (error) {
    warn('could not publish window.__HEI_POSTER__', error)
  }

  try {
    cancelBodyWait = attachWhenBodyReady(doc, mount, () => {
      giveUp('document.body never appeared; the cover was not mounted')
    })
  } catch (error) {
    warn('could not start waiting for <body>', error)
  }
}

/**
 * Client half entry point. Empty inject on purpose: this half only touches the
 * DOM, so there is no service it could read without declaring it.
 */
export const inject = []

export function apply(ctx: any): void {
  /** Holds the real teardown as soon as mountOverlay has one. */
  const teardownSlot: { current: (() => void) | null } = { current: null }

  // Registered before the first side effect: if anything below throws, the host
  // still has a disposer for whatever had already been created by then.
  try {
    if (ctx !== null && ctx !== undefined && typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        try {
          if (teardownSlot.current !== null) teardownSlot.current()
        } catch (error) {
          warn('teardown failed', error)
        }
      }, PACKAGE_ID + ': boot poster cover')
    } else {
      warn('ctx.effect is unavailable; the cover will not be cleaned up on unload')
    }
  } catch (error) {
    warn('could not register the ctx.effect teardown', error)
  }

  try {
    mountOverlay(teardownSlot)
  } catch (error) {
    warn('apply() failed; DSH keeps running without the boot cover', error)
  }
}
