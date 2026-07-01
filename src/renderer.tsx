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

import { Excalidraw, MainMenu, serializeAsJSON, restore, FONT_FAMILY } from '@excalidraw/excalidraw'
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

// F09/F10: die Canvas-Font-Familien, die build.mjs als data:-@font-face einbettet (Nicht-CJK). MUSS mit der
// `EMBEDDED_FONTS`-Liste in build.mjs übereinstimmen — vor jedem Mount wird verlangt, dass JEDE dieser Familien
// lädt (fail-closed), sonst read-only. Nicht eingebettet: Xiaolai/CJK (dokumentierte Fallback-Grenze).
const SUPPORTED_FONT_FAMILIES = [
  'Excalifont',
  'Nunito',
  'Comic Shanns',
  'Virgil',
  'Cascadia',
  'Lilita One',
  'Liberation Sans',
] as const

// F11 (fail-closed): fontFamily-IDs der 7 eingebetteten Familien, aus Excalidraws FONT_FAMILY-Registry
// (Virgil:1, Cascadia:3, Excalifont:5, Nunito:6, "Lilita One":7, "Comic Shanns":8, "Liberation Sans":9).
// Eine Szene mit einer NICHT eingebetteten Familie (Helvetica=2 = „Helvetica on macOS, Arial on Win", oder
// CJK/Xiaolai) misst gegen den plattformabhängigen local()-/Fallback-Font → nicht portable Geometrie.
const EMBEDDED_FONT_IDS = new Set<number>(
  SUPPORTED_FONT_FAMILIES
    .map((f) => (FONT_FAMILY as Record<string, number>)[f])
    .filter((id): id is number => typeof id === 'number'),
)

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
  const [phase, setPhase] = useState<'loading' | 'ready' | 'load-error' | 'font-error' | 'unsupported-font'>('loading')
  const [fontError, setFontError] = useState<string>('')
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
        // F11 (fail-closed): eine importierte/Legacy-Szene kann eine NICHT eingebettete Familie nutzen
        // (Helvetica ID 2, oder CJK/Xiaolai). Die misst gegen den plattformabhängigen Fallback → driftende,
        // nicht portable gespeicherte Geometrie. Analog zum Font-Preload: dann NICHT ready+speichern, sondern
        // read-only. Neue/leere Szenen (Default = eingebettetes Excalifont) sind unberührt.
        const usedFontIds = new Set<number>()
        for (const el of (((scene as { elements?: unknown })?.elements ?? []) as Array<{ type?: string; fontFamily?: number }>)) {
          if (el?.type === 'text' && typeof el.fontFamily === 'number') usedFontIds.add(el.fontFamily)
        }
        const unsupportedIds = [...usedFontIds].filter((id) => !EMBEDDED_FONT_IDS.has(id))
        if (unsupportedIds.length > 0) {
          host.log('Szene nutzt nicht eingebettete Schrift(en) (fail-closed, read-only):', unsupportedIds)
          setFontError(`fontFamily ${unsupportedIds.join(', ')} (z. B. Helvetica = ID 2, oder CJK) — nicht eingebettet.`)
          setPhase('unsupported-font')
          return
        }
        // F01+F10 (fail-closed): die eingebetteten Canvas-Fonts laden, BEVOR Excalidraw rendert/misst — sonst
        // misst measureText gegen den System-Fallback und persistiert falsche Textgeometrie (Cross-Tool/Cross-
        // OS-Drift). Wir rufen FontFace.load() auf den CSS-registrierten data:-Faces auf (NICHT
        // document.fonts.load(, das im Excalidraw-Bundle neutralisiert + vom Gate verboten ist). WICHTIG (F10):
        // Fehler NICHT verschlucken — scheitert eine unterstützte Familie (CSP-Regression, korruptes data:-
        // Asset, Decode-Fehler), gehen wir in 'font-error' + read-only statt still falsche Geometrie zu schreiben.
        const fontFail: string[] = []
        for (const family of SUPPORTED_FONT_FAMILIES) {
          const faces = [...document.fonts].filter((ff) => ff.family === family)
          if (faces.length === 0) {
            fontFail.push(`${family}: kein Face registriert`)
            continue
          }
          try {
            await Promise.all(faces.map((ff) => ff.load()))
          } catch (e) {
            fontFail.push(`${family}: load-Fehler (${e instanceof Error ? e.message : String(e)})`)
            continue
          }
          // Status prüfen statt document.fonts.check() — letzteres ist weight-sensibel (Nunito ist als 500
          // eingebettet, check('16px Nunito') fragt aber 400) und würde falsch-negativ melden.
          const notLoaded = faces.filter((ff) => ff.status !== 'loaded')
          if (notLoaded.length > 0) fontFail.push(`${family}: ${notLoaded.length}/${faces.length} Face(s) nicht 'loaded'`)
        }
        if (cancelled) return
        if (fontFail.length > 0) {
          host.log('Font-Preload fehlgeschlagen (fail-closed, read-only):', fontFail)
          setFontError(fontFail.join('; '))
          setPhase('font-error')
          return
        }
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
  if (phase === 'font-error') {
    return (
      <div style={msgStyle}>
        Schriften konnten nicht geladen werden — Bearbeitung ist deaktiviert (read-only), um falsche, dauerhaft
        gespeicherte Textgeometrie zu vermeiden.
        <br />
        <span style={{ fontSize: 11, opacity: 0.7 }}>{fontError}</span>
      </div>
    )
  }
  if (phase === 'unsupported-font') {
    return (
      <div style={msgStyle}>
        Diese Zeichnung nutzt eine Schrift, die dieses Plugin nicht einbettet (z. B. Helvetica oder CJK). Sie ist
        schreibgeschützt geöffnet, damit keine plattformabhängige (macOS/Windows/Linux unterschiedliche) Text-
        geometrie dauerhaft gespeichert wird.
        <br />
        <span style={{ fontSize: 11, opacity: 0.7 }}>{fontError}</span>
      </div>
    )
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

// Font-Strategie (F01/F02): Excalidraws eigener CDN-Font-Loadpfad ist im Build (build.mjs) neutralisiert;
// die 3 Canvas-Default-Familien werden als data:-@font-face mitgeliefert (styles.css) und pro Editor-Mount
// via FontFace.load() vorgeladen (siehe oben), damit measureText echte Metriken bekommt. KEIN globaler
// FontFace-Prototype-Override mehr (der würde die eigenen data:-Fonts blockieren).
const plugin: PluginRendererModule = {
  id: 'mindgraph-excalidraw',
  activate(host) {
    host.log('Excalidraw-Plugin aktiviert')
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
}

export default plugin
