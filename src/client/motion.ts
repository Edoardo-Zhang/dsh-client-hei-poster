/** The poster motion owns only its stylesheet, stage classes and two layer styles. */
export const MOTION_CSS: string = [
  '.stage.is-motion .poster{display:block}',
  '.stage.is-motion .hei-motion-a,.stage.is-motion .hei-motion-b{',
  'animation-duration:var(--hei-motion-duration,12000ms);',
  'animation-delay:var(--hei-motion-delay,0ms);',
  'animation-play-state:var(--hei-motion-play-state,running);',
  'animation-timing-function:ease-in-out;',
  'animation-iteration-count:infinite;animation-fill-mode:both;}',
  '.stage.is-motion .hei-motion-a{animation-name:hei-poster-a}',
  '.stage.is-motion .hei-motion-b{animation-name:hei-poster-b}',
  '.stage.is-motion.is-reversed .hei-motion-a{animation-name:hei-poster-b}',
  '.stage.is-motion.is-reversed .hei-motion-b{animation-name:hei-poster-a}',
  '@keyframes hei-poster-a{',
  '0%{opacity:1;transform:scale(1)}',
  '16.6666667%{opacity:1;transform:scale(1.015)}',
  '33.3333333%{opacity:0;transform:scale(1.03)}',
  '83.3333333%{opacity:0;transform:scale(1.03)}',
  '100%{opacity:1;transform:scale(1)}',
  '}',
  '@keyframes hei-poster-b{',
  '0%{opacity:0;transform:scale(1.03)}',
  '33.3333333%{opacity:0;transform:scale(1.03)}',
  '50%{opacity:1;transform:scale(1.015)}',
  '66.6666667%{opacity:1;transform:scale(1)}',
  '83.3333333%{opacity:0;transform:scale(1.03)}',
  '100%{opacity:0;transform:scale(1.03)}',
  '}',
].join('\n')

export interface MotionDeps {
  doc: Document
  stage: HTMLElement
  layers: HTMLElement[]
  cycleMs?: number
  reducedMotion?: boolean
  log?(message: string): void
}

export interface MotionHandle {
  start(from: number): void
  stop(): void
  seek(phase: number): void
  readonly phase: number
  readonly mode: "animated" | "static"
  readonly active: boolean
  dispose(): void
}

/** No exception may escape into the host's boot path. */
export function createMotion(deps: MotionDeps): MotionHandle {
  let style: HTMLStyleElement | null = null
  let disposed = false
  let broken = false
  let logged = false
  let currentMode: "animated" | "static" = "static"
  let running = false
  let currentFrom = 0
  let heldPhase = 0
  let startedAt = 0
  const duration = Number.isFinite(deps.cycleMs) && (deps.cycleMs as number) > 0
    ? (deps.cycleMs as number) : 12000

  function clock(): number {
    return deps.doc.defaultView?.performance?.now() ?? Date.now()
  }

  function clearLayerStyles(): void {
    for (const layer of deps.layers) {
      try { layer.style.removeProperty('opacity') } catch { /* continue cleanup */ }
      try { layer.style.removeProperty('transform') } catch { /* continue cleanup */ }
    }
  }

  function staticMode(): void {
    running = false
    currentMode = 'static'
    try { deps.stage.classList.remove('is-motion', 'is-reversed') } catch { /* continue cleanup */ }
    try { deps.stage.style.removeProperty('--hei-motion-duration') } catch { /* continue cleanup */ }
    try { deps.stage.style.removeProperty('--hei-motion-delay') } catch { /* continue cleanup */ }
    try { deps.stage.style.removeProperty('--hei-motion-play-state') } catch { /* continue cleanup */ }
    clearLayerStyles()
  }

  function fail(error: unknown): void {
    broken = true
    if (!logged) {
      logged = true
      try { deps.log?.('poster motion fell back to static: ' + String(error)) } catch { /* cosmetic only */ }
    }
    staticMode()
  }

  function canAnimate(): boolean {
    if (deps.reducedMotion === true) return false
    if (deps.doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false
    if (deps.layers.length < 2) return false
    return deps.layers.every((layer) => {
      const image = layer as HTMLImageElement
      return image.naturalWidth !== 0 && image.complete !== false
    })
  }

  function readPhase(): number {
    if (!running) return heldPhase
    const elapsed = Math.max(0, clock() - startedAt)
    return (heldPhase + elapsed / duration) % 1
  }

  try {
    style = deps.doc.createElement('style')
    style.textContent = MOTION_CSS
    deps.stage.appendChild(style)
    deps.layers[0]?.classList.add('hei-motion-a')
    deps.layers[1]?.classList.add('hei-motion-b')
    // Image decoding is asynchronous; start() checks again after it settles.
    if (!canAnimate()) staticMode()
  } catch (error) {
    fail(error)
  }

  return {
    start(from: number): void {
      try {
        if (disposed || broken) return
        if (!canAnimate()) { staticMode(); return }
        const nextFrom = from === 1 ? 1 : 0
        if (running && currentMode === 'animated' && currentFrom === nextFrom) return
        currentFrom = nextFrom
        heldPhase = 0
        startedAt = clock()
        const first = deps.layers[0]
        const second = deps.layers[1]
        // Animation keyframes supersede these normal inline values while active.
        first.style.opacity = nextFrom === 0 ? '1' : '0'
        first.style.transform = nextFrom === 0 ? 'scale(1)' : 'scale(1.03)'
        second.style.opacity = nextFrom === 1 ? '1' : '0'
        second.style.transform = nextFrom === 1 ? 'scale(1)' : 'scale(1.03)'
        deps.stage.style.setProperty('--hei-motion-duration', duration + 'ms')
        deps.stage.style.setProperty('--hei-motion-delay', '0ms')
        deps.stage.style.setProperty('--hei-motion-play-state', 'running')
        deps.stage.classList.toggle('is-reversed', nextFrom === 1)
        deps.stage.classList.add('is-motion')
        currentMode = 'animated'
        running = true
      } catch (error) { fail(error) }
    },
    stop(): void {
      try {
        if (disposed || !running) return
        heldPhase = readPhase()
        running = false
        deps.stage.style.setProperty('--hei-motion-play-state', 'paused')
      } catch (error) { fail(error) }
    },
    seek(phase: number): void {
      try {
        heldPhase = Number.isNaN(phase) ? 0 : Math.max(0, Math.min(1, phase))
        if (disposed || currentMode !== 'animated') return
        // Paused CSS animation + negative delay is the deterministic frame source.
        deps.stage.style.setProperty('--hei-motion-play-state', 'paused')
        deps.stage.style.setProperty('--hei-motion-delay', '-' + (heldPhase * duration) + 'ms')
        running = false
      } catch (error) { fail(error) }
    },
    get phase(): number {
      try { return readPhase() } catch (error) { fail(error); return heldPhase }
    },
    get mode(): "animated" | "static" { return currentMode },
    get active(): boolean { return running },
    dispose(): void {
      try {
        if (disposed) return
        disposed = true
        staticMode()
        try { deps.layers[0]?.classList.remove('hei-motion-a') } catch { /* continue cleanup */ }
        try { deps.layers[1]?.classList.remove('hei-motion-b') } catch { /* continue cleanup */ }
        if (style?.parentNode) style.parentNode.removeChild(style)
        style = null
      } catch (error) { fail(error) }
    },
  }
}
