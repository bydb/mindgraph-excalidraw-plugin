// MindGraph Excalidraw Renderer-Plugin (R1b) — Default-Export gegen den R1a-Host-Vertrag.
//
// Vertrag (@mindgraph/plugin-api): export default { id, activate(host) };
// host.registerFileEditor({ editorId, mount }); mount(container, { filePath, host }) => dispose (eigenes createRoot).
// Persistenz über host.vault (Komfort-Bridge → writeFileSafe). Theme über host.theme/onThemeChange.
//
// F02: Fonts sind im Build (build.mjs) auf System-Fallback neutralisiert (kein CSP-Font-Block).
// F03/F08: serialisierter, coalescender Save-Controller + Hydration-Guard + Fehler-States (kein Datenverlust,
//          kein Überschreiben korrupter Dateien). KEIN Final-Flush im dispose — R1a drained Host-Calls VOR
//          dem Renderer-Teardown, daher wird kontinuierlich (debounced) während des Editierens gespeichert.
// F05: Excalidraws native Datei-/Export-Oberflächen (Öffnen/Speichern/Export/Menu) sind abgeschaltet.

import { Excalidraw, MainMenu, serializeAsJSON, restore } from '@excalidraw/excalidraw'
import { createRoot, type Root } from 'react-dom/client'
import { useCallback, useEffect, useRef, useState } from 'react'

// — schmaler Host-Vertrag (type-only; zur Laufzeit erased). Vollständig in @mindgraph/plugin-api. —
interface PluginRendererHost {
  readonly id: string
  registerFileEditor(opts: { editorId: string; mount: FileEditorMount }): void
  readonly vault: {
    read(p: string): Promise<string>
    exists(p: string): Promise<boolean>
    write(p: string, c: string): Promise<void>
  }
  readonly theme: 'light' | 'dark'
  onThemeChange(cb: (t: 'light' | 'dark') => void): () => void
  log(...args: unknown[]): void
}
type FileEditorMount = (container: HTMLElement, ctx: { filePath: string; host: PluginRendererHost }) => () => void
interface PluginRendererModule {
  id: string
  activate(host: PluginRendererHost): void
  deactivate?(): void
}

/**
 * Serialisierter, coalescender Save-Controller (F03): höchstens EIN vault.write in flight; danach immer den
 * NEUESTEN dirty-Snapshot. Weil `drain()` sequentiell awaited, kann kein älteres Ergebnis ein neueres
 * überschreiben (Out-of-Order unmöglich — die Serialisierung IST der Revisions-Guard). Ein Schreibfehler
 * behält den dirty-Snapshot (retrybar beim nächsten Edit) und meldet 'error'.
 */
class SaveController {
  private saved = ''
  private dirty: string | null = null
  private writing = false
  private disposed = false
  constructor(
    private readonly write: (json: string) => Promise<void>,
    private readonly onStatus: (s: 'idle' | 'saving' | 'error') => void,
    private readonly onError: (e: unknown) => void,
  ) {}
  /** Baseline = kanonische Serialisierung der geladenen Szene → der erste onChange (== geladen) speichert nicht. */
  setBaseline(json: string): void {
    this.saved = json
  }
  schedule(json: string): void {
    if (this.disposed || json === this.saved) return
    this.dirty = json
    if (!this.writing) void this.drain()
  }
  private async drain(): Promise<void> {
    this.writing = true
    this.onStatus('saving')
    try {
      while (!this.disposed && this.dirty !== null && this.dirty !== this.saved) {
        const attempt = this.dirty
        await this.write(attempt) // ≤1 in flight, sequentiell
        this.saved = attempt
        if (this.dirty === attempt) this.dirty = null // kein neuerer Edit während des Schreibens
      }
      this.onStatus('idle')
    } catch (e) {
      this.onError(e) // dirty bleibt → retrybar
      this.onStatus('error')
    } finally {
      this.writing = false
    }
  }
  dispose(): void {
    this.disposed = true
  }
}

function ExcalidrawEditor({ filePath, host }: { filePath: string; host: PluginRendererHost }): JSX.Element {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'load-error'>('loading')
  const [initialData, setInitialData] = useState<ReturnType<typeof restore> | null>(null)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'error'>('idle')
  const [theme, setTheme] = useState<'light' | 'dark'>(host.theme)
  const controllerRef = useRef<SaveController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => host.onThemeChange((t) => mountedRef.current && setTheme(t)), [host])

  useEffect(() => {
    mountedRef.current = true
    let cancelled = false
    const controller = new SaveController(
      (json) => host.vault.write(filePath, json),
      (s) => mountedRef.current && setSaveStatus(s),
      (e) => host.log('Speichern fehlgeschlagen:', e),
    )
    controllerRef.current = controller
    setPhase('loading')

    void (async () => {
      try {
        let scene: unknown = { elements: [], appState: {}, files: {} }
        if (await host.vault.exists(filePath)) {
          const content = await host.vault.read(filePath)
          if (content && content.trim()) {
            try {
              scene = JSON.parse(content)
            } catch {
              // F08: korruptes JSON NIE mit einer leeren Szene überschreiben → Editing gesperrt.
              if (!cancelled) setPhase('load-error')
              return
            }
          }
        }
        if (cancelled) return
        const restored = restore(scene as never, null, null)
        setInitialData(restored)
        // Baseline setzen BEVOR Editing aktiv wird (Hydration-Guard über phase==='ready').
        controller.setBaseline(serializeAsJSON(restored.elements, restored.appState, restored.files ?? {}, 'local'))
        setPhase('ready')
      } catch (e) {
        host.log('Laden fehlgeschlagen:', e)
        if (!cancelled) setPhase('load-error')
      }
    })()

    return () => {
      cancelled = true
      mountedRef.current = false
      if (debounceRef.current) clearTimeout(debounceRef.current)
      controller.dispose()
    }
  }, [filePath, host])

  const onChange = useCallback(
    (elements: readonly unknown[], appState: unknown, files: unknown) => {
      if (phase !== 'ready') return // Hydration-Guard: kein Autosave vor geladener Szene
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        const json = serializeAsJSON(elements as never, appState as never, files as never, 'local')
        controllerRef.current?.schedule(json)
      }, 500)
    },
    [phase],
  )

  if (phase === 'loading') return <div style={msgStyle}>Lädt …</div>
  if (phase === 'load-error') {
    return <div style={msgStyle}>Datei konnte nicht geladen werden (ungültiges JSON). Bearbeitung deaktiviert, um Datenverlust zu vermeiden.</div>
  }

  return (
    <div style={{ height: '100%', width: '100%', position: 'relative' }} data-theme={theme}>
      <Excalidraw
        initialData={initialData as never}
        theme={theme}
        onChange={onChange as never}
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            saveFileToDisk: false,
            export: false,
          },
        }}
      >
        <MainMenu>
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.DefaultItems.ClearCanvas />
        </MainMenu>
      </Excalidraw>
      {saveStatus !== 'idle' && (
        <div style={{ ...saveStyle, ...(saveStatus === 'error' ? { color: '#b00', borderColor: '#b00' } : {}) }}>
          {saveStatus === 'saving' ? 'Speichert …' : 'Speichern fehlgeschlagen — bleibt gemerkt, erneuter Versuch beim nächsten Edit.'}
        </div>
      )}
    </div>
  )
}

const msgStyle: React.CSSProperties = { padding: '1.5rem', color: 'var(--text-secondary, #888)' }
const saveStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 8,
  right: 12,
  fontSize: 12,
  padding: '2px 8px',
  borderRadius: 6,
  background: 'var(--bg-primary-custom, #fff)',
  border: '1px solid var(--border-color, #ddd)',
  color: 'var(--text-secondary, #888)',
  pointerEvents: 'none',
}

// F02: Excalidraw lädt seine Fonts zur Laufzeit vom esm.sh-CDN (hardcodierter ASSETS_FALLBACK_URL im
// Bundle) via FontFace.load() → die Host-CSP (default-src 'self') blockt jeden der ~230 Subsets (Konsolen-
// Noise). Wir wollen KEIN Netzwerk-Font-Loading (Privacy + sauberes Log); Text nutzt den System-Fallback.
// Da die Ladepfade minifiziert + mehrfach sind, ist der robusteste mechanismus-unabhängige Punkt der
// globale FontFace.load-Prototype: no-oppen bei aktivem Editor, beim Deactivate wiederherstellen. Der Host
// lädt seine eigenen Fonts beim App-Start (VOR Plugin-Aktivierung) → bleibt unberührt.
type FontFaceLoad = (typeof FontFace)['prototype']['load']
let originalFontFaceLoad: FontFaceLoad | null = null
function suppressFontLoading(): void {
  if (typeof FontFace === 'undefined' || originalFontFaceLoad) return
  originalFontFaceLoad = FontFace.prototype.load
  FontFace.prototype.load = function (this: FontFace) {
    return Promise.resolve(this)
  }
}
function restoreFontLoading(): void {
  if (originalFontFaceLoad) {
    FontFace.prototype.load = originalFontFaceLoad
    originalFontFaceLoad = null
  }
}

const plugin: PluginRendererModule = {
  id: 'mindgraph-excalidraw',
  activate(host) {
    host.log('Excalidraw-Plugin aktiviert')
    suppressFontLoading()
    let root: Root | null = null
    host.registerFileEditor({
      editorId: 'excalidraw',
      mount(container, ctx) {
        root = createRoot(container)
        root.render(<ExcalidrawEditor filePath={ctx.filePath} host={ctx.host} />)
        return () => {
          root?.unmount()
          root = null
        }
      },
    })
  },
  deactivate() {
    restoreFontLoading()
  },
}

export default plugin
