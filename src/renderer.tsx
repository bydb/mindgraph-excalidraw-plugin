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

import {
  Excalidraw,
  MainMenu,
  serializeAsJSON,
  serializeLibraryAsJSON,
  restore,
  restoreLibraryItems,
  exportToSvg,
  FONT_FAMILY,
} from '@excalidraw/excalidraw'
import { createRoot, type Root } from 'react-dom/client'
import { useCallback, useEffect, useRef, useState } from 'react'

// — schmaler Host-Vertrag (type-only; zur Laufzeit erased). Vollständig in @mindgraph/plugin-api. —
interface PluginRendererHost {
  readonly id: string
  registerFileEditor(opts: { editorId: string; mount: FileEditorMount }): void
  /** Read-only-Inline-Embed (R2, Host-API ≥0.2.1) — optional, ältere Hosts kennen es nicht. */
  registerFileEmbed?(opts: { editorId: string; mount: FileEditorMount }): void
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
  deactivate?(): void | Promise<void>
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
 *
 * Schließen (F10, 07.10.2026): `close()` nimmt keine neuen Snapshots mehr an, lässt den laufenden Drain aber
 * zu Ende schreiben — inklusive des zuletzt eingereihten Snapshots. Vorher brach `dispose()` die Schleife ab,
 * und eine Änderung aus den letzten 500 ms vor dem Tab-Schließen ging verloren.
 */
class SaveController {
  private saved = ''
  private dirty: string | null = null
  private draining: Promise<void> | null = null
  private closed = false
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
    if (this.closed || json === this.saved) return
    this.dirty = json
    if (!this.draining) this.draining = this.drain().finally(() => { this.draining = null })
  }
  private async drain(): Promise<void> {
    this.onStatus('saving')
    try {
      while (this.dirty !== null && this.dirty !== this.saved) {
        const attempt = this.dirty
        await this.write(attempt) // ≤1 in flight, sequentiell
        this.saved = attempt
        if (this.dirty === attempt) this.dirty = null // kein neuerer Edit während des Schreibens
      }
      this.onStatus('idle')
    } catch (e) {
      this.onError(e) // dirty bleibt → retrybar (solange nicht geschlossen)
      this.onStatus('error')
    }
  }
  /** Keine neuen Snapshots mehr; Promise erfüllt sich, wenn alles Eingereihte geschrieben (oder gescheitert) ist. */
  close(): Promise<void> {
    this.closed = true
    return this.draining ?? Promise.resolve()
  }
}

// F10: Schreibvorgänge, die ein geschlossener Editor noch zu Ende bringt — pro Datei der letzte. Ein sofort
// wieder geöffneter Editor wartet darauf, bevor er liest; sonst lädt er den alten Stand und überschreibt den
// gerade gesicherten beim nächsten Edit.
//
// Grenze (gemessen 07.10.2026): Beim Abschalten/Aktualisieren des Plugins schließt der Host das Call-Gate,
// BEVOR er die Mounts abbaut (Drain-Reihenfolge aus dem Renderer-Host-ADR). Ein Speichern aus dem Abbau heraus
// wird dann mit „Renderer-Instanz nicht aktiv“ abgelehnt. Verloren geht dabei höchstens, was in den letzten
// 500 ms vor dem Abschalten gezeichnet wurde; ein laufender Schreibvorgang wird vom Host-Drain noch abgewartet.
const closingWrites = new Map<string, Promise<void>>()

function trackClosingWrite(filePath: string, done: Promise<void>): void {
  const p = done.catch(() => {}) // Fehler meldet der Controller selbst; hier nur Reihenfolge
  closingWrites.set(filePath, p)
  void p.then(() => {
    if (closingWrites.get(filePath) === p) closingWrites.delete(filePath)
  })
}

// ─── Bibliothek (Library) — eine pro Vault ─────────────────────────────────────────────────────────
// Liegt als JSON unter .mindgraph/, damit der Sync sie mitnimmt (JSON in .mindgraph wird synchronisiert;
// .excalidrawlib nicht). Inhalt = das normale .excalidrawlib-Format (serializeLibraryAsJSON).
//
// Regeln (Codex F06): geladen wird VOR dem ersten Rendern (initialData.libraryItems), geschrieben über
// denselben serialisierten SaveController wie die Zeichnung. Eine unlesbare Datei wird NIE überschrieben —
// Änderungen bleiben dann ungespeichert und der Editor sagt das. Mehrere offene Editoren werden gleich-
// gezogen (updateLibrary), sonst überschriebe der zweite Tab die Ergänzungen des ersten.
const LIBRARY_PATH = '.mindgraph/excalidraw-library.json'

interface LibraryApi {
  updateLibrary(opts: { libraryItems: unknown; merge?: boolean }): Promise<unknown>
}

class LibraryStore {
  private items: unknown[] = []
  private lastJson = ''
  private loading: Promise<void> | null = null
  private controller: SaveController | null = null
  private readonly editors = new Set<LibraryApi>()
  private readonly statusListeners = new Set<(broken: boolean) => void>()
  broken = false

  /** Liest die Datei neu, solange kein Editor offen ist (so kommen per Sync geänderte Bibliotheken an). */
  async load(host: PluginRendererHost): Promise<unknown[]> {
    if (this.editors.size === 0 && !this.loading) this.loading = this.read(host).finally(() => { this.loading = null })
    if (this.loading) await this.loading
    return this.items
  }

  private async read(host: PluginRendererHost): Promise<void> {
    if (!this.controller) {
      this.controller = new SaveController(
        (json) => host.vault.write(LIBRARY_PATH, json),
        () => {},
        (e) => host.log('Bibliothek speichern fehlgeschlagen:', e),
      )
    }
    let items: unknown[] = []
    let broken = false
    try {
      if (await host.vault.exists(LIBRARY_PATH)) {
        const content = await host.vault.read(LIBRARY_PATH)
        if (content.trim()) {
          const parsed = JSON.parse(content) as { libraryItems?: unknown; library?: unknown }
          const raw = parsed.libraryItems ?? parsed.library ?? []
          if (!Array.isArray(raw)) throw new Error('libraryItems ist keine Liste')
          items = restoreLibraryItems(raw as never, 'unpublished') as unknown[]
        }
      }
    } catch (e) {
      host.log('Bibliothek unlesbar — wird nicht überschrieben:', e)
      broken = true
    }
    this.items = items
    this.lastJson = serializeLibraryAsJSON(items as never)
    this.controller.setBaseline(this.lastJson)
    this.setBroken(broken)
  }

  private setBroken(broken: boolean): void {
    this.broken = broken
    for (const l of this.statusListeners) l(broken)
  }

  onStatus(cb: (broken: boolean) => void): () => void {
    this.statusListeners.add(cb)
    return () => this.statusListeners.delete(cb)
  }

  attach(api: LibraryApi): () => void {
    this.editors.add(api)
    return () => this.editors.delete(api)
  }

  /** onLibraryChange eines Editors: speichern und die anderen offenen Editoren gleichziehen. */
  changed(source: LibraryApi | null, items: readonly unknown[]): void {
    const json = serializeLibraryAsJSON(items as never)
    if (json === this.lastJson) return // eigenes Echo oder Initial-Callback
    this.items = [...items]
    this.lastJson = json
    if (!this.broken) this.controller?.schedule(json)
    for (const api of this.editors) {
      if (api !== source) void api.updateLibrary({ libraryItems: this.items, merge: false })
    }
  }
}
const libraryStore = new LibraryStore()

/**
 * Oberflächensprache aus <html lang> (setzt die App aus ihrer Spracheinstellung) — folgt Änderungen live.
 * Excalidraw schreibt beim Sprachwechsel selbst `document.documentElement.lang` (z. B. „de-DE“); das löst den
 * Observer erneut aus, bildet aber auf denselben Code ab — kein Pingpong.
 */
function appLangCode(): string {
  return (document.documentElement.lang || 'de').toLowerCase().startsWith('en') ? 'en' : 'de-DE'
}
function useAppLangCode(): string {
  const [code, setCode] = useState(appLangCode)
  useEffect(() => {
    const obs = new MutationObserver(() => setCode(appLangCode()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    return () => obs.disconnect()
  }, [])
  return code
}

function ExcalidrawEditor({ filePath, host }: { filePath: string; host: PluginRendererHost }): JSX.Element {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'load-error' | 'font-error' | 'unsupported-font'>('loading')
  const [fontError, setFontError] = useState<string>('')
  const [initialData, setInitialData] = useState<ReturnType<typeof restore> | null>(null)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'error'>('idle')
  const [theme, setTheme] = useState<'light' | 'dark'>(host.theme)
  const langCode = useAppLangCode()
  const [libraryBroken, setLibraryBroken] = useState(libraryStore.broken)
  const libraryApiRef = useRef<LibraryApi | null>(null)
  const controllerRef = useRef<SaveController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // F10: letzter onChange-Stand, der noch im Debounce hängt (noch nicht an den Controller übergeben).
  const pendingSceneRef = useRef<{ elements: readonly unknown[]; appState: unknown; files: unknown } | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => host.onThemeChange((t) => mountedRef.current && setTheme(t)), [host])
  useEffect(() => libraryStore.onStatus(setLibraryBroken), [])
  // Bibliothek: Editor beim Store anmelden, sobald Excalidraw sein API-Objekt übergibt; beim Unmount ab.
  const detachLibraryRef = useRef<(() => void) | null>(null)
  const onExcalidrawApi = useCallback((api: unknown) => {
    detachLibraryRef.current?.()
    libraryApiRef.current = api as LibraryApi
    detachLibraryRef.current = libraryStore.attach(api as LibraryApi)
  }, [])
  useEffect(() => () => {
    detachLibraryRef.current?.()
    detachLibraryRef.current = null
  }, [])

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

    // F10: Hängendes sofort einreihen (statt den Debounce-Timer zu verwerfen).
    const flushPending = (): void => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
      const pending = pendingSceneRef.current
      pendingSceneRef.current = null
      if (pending) {
        controller.schedule(serializeAsJSON(pending.elements as never, pending.appState as never, pending.files as never, 'local'))
      }
    }

    void (async () => {
      try {
        // F10: ein gerade geschlossener Editor derselben Datei schreibt evtl. noch — erst danach lesen.
        await closingWrites.get(filePath)
        if (cancelled) return
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
        // F11 (Rest): die Default-Schrift für NEUE Elemente (appState.currentItemFontFamily) auf eine
        // eingebettete normalisieren, falls die Szene eine nicht eingebettete mitbringt (z. B. Helvetica).
        // Sonst würde neu erstellter Text gegen den plattformabhängigen Fallback driften, obwohl alle
        // vorhandenen Elemente eingebettete Familien nutzen. restore() lässt currentItemFontFamily sonst stehen.
        const curFont = (restored.appState as { currentItemFontFamily?: number }).currentItemFontFamily
        if (typeof curFont === 'number' && !EMBEDDED_FONT_IDS.has(curFont)) {
          ;(restored.appState as { currentItemFontFamily?: number }).currentItemFontFamily = FONT_FAMILY.Excalifont
        }
        // Bibliothek VOR dem ersten Rendern laden (Codex F06: Hydration über initialData, nicht nachträglich).
        const libraryItems = await libraryStore.load(host)
        if (cancelled) return
        setInitialData({ ...restored, libraryItems } as typeof restored)
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
      // F10: KEIN Verwerfen mehr — Hängendes schreiben und den Drain zu Ende laufen lassen. Der Host baut beim
      // Tab-Schließen nur diesen Mount ab; das Plugin und sein Vault-Zugang bleiben bestehen.
      flushPending()
      trackClosingWrite(filePath, controller.close())
    }
  }, [filePath, host])

  const onChange = useCallback(
    (elements: readonly unknown[], appState: unknown, files: unknown) => {
      if (phase !== 'ready') return // Hydration-Guard: kein Autosave vor geladener Szene
      if (debounceRef.current) clearTimeout(debounceRef.current)
      pendingSceneRef.current = { elements, appState, files }
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        const pending = pendingSceneRef.current
        pendingSceneRef.current = null
        if (!pending) return
        const json = serializeAsJSON(pending.elements as never, pending.appState as never, pending.files as never, 'local')
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
        langCode={langCode}
        excalidrawAPI={onExcalidrawApi as never}
        onLibraryChange={(items: readonly unknown[]) => libraryStore.changed(libraryApiRef.current, items)}
        // Keine KI-Funktionen, die einen Excalidraw-Server bräuchten (lokal-first). Mermaid bleibt — lokal.
        aiEnabled={false}
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
          <MainMenu.DefaultItems.CommandPalette />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.DefaultItems.ClearCanvas />
        </MainMenu>
      </Excalidraw>
      {libraryBroken && (
        <div style={{ ...saveStyle, bottom: 36, color: '#b00', borderColor: '#b00' }}>
          Bibliothek-Datei unlesbar ({LIBRARY_PATH}) — Änderungen an der Bibliothek werden nicht gespeichert.
        </div>
      )}
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

/**
 * Read-only-Inline-Embed (R2): rendert die Zeichnung als statisches SVG via exportToSvg — KEIN
 * Excalidraw-Canvas pro Embed (mehrere Embeds pro Notiz bleiben billig), KEIN vault.write (Vertrag).
 *
 * Fonts: skipInliningFonts (der Subsetting-Worker ist im Build zu No-Ops geshimmt — Inlining würde
 * scheitern). Das SVG steht INLINE im Dokument, dessen data:-@font-face (styles.css, vom Host global
 * appliziert) die Familien auflöst. Nicht eingebettete Familien (Helvetica/CJK) fallen auf Systemfonts
 * zurück — fürs read-only ANZEIGEN akzeptabel (exportToSvg nutzt die GESPEICHERTE Geometrie, es wird
 * nichts neu gemessen oder geschrieben; der fail-closed-Pfad gilt nur für den schreibenden Editor).
 */
function mountEmbed(container: HTMLElement, ctx: { filePath: string; host: PluginRendererHost }): () => void {
  let disposed = false

  const showMsg = (text: string): void => {
    container.textContent = ''
    const msg = document.createElement('div')
    msg.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;padding:16px;color:var(--text-secondary,#888);font-size:13px;text-align:center;'
    msg.textContent = text
    container.appendChild(msg)
  }

  const render = async (theme: 'light' | 'dark'): Promise<void> => {
    try {
      const content = await ctx.host.vault.read(ctx.filePath)
      if (disposed) return
      if (!content || !content.trim()) {
        showMsg('Leere Zeichnung — „Öffnen" startet den Editor.')
        return
      }
      const restored = restore(JSON.parse(content) as never, null, null)
      if (restored.elements.length === 0) {
        showMsg('Leere Zeichnung — „Öffnen" startet den Editor.')
        return
      }
      const svg = await exportToSvg({
        elements: restored.elements,
        appState: {
          ...restored.appState,
          exportBackground: true,
          exportWithDarkMode: theme === 'dark',
        },
        files: restored.files ?? null,
        exportPadding: 16,
        skipInliningFonts: true,
      })
      if (disposed) return
      // Responsiv in die feste Host-Box einpassen: viewBox sicherstellen, Größe der CSS überlassen —
      // preserveAspectRatio (Default xMidYMid meet) skaliert und zentriert verzerrungsfrei.
      const w = parseFloat(svg.getAttribute('width') || '0')
      const h = parseFloat(svg.getAttribute('height') || '0')
      if (w > 0 && h > 0 && !svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
      svg.removeAttribute('width')
      svg.removeAttribute('height')
      svg.style.width = '100%'
      svg.style.height = '100%'
      svg.style.display = 'block'
      container.textContent = ''
      container.appendChild(svg)
    } catch (e) {
      if (disposed) return
      ctx.host.log('Embed-Render fehlgeschlagen:', e)
      showMsg('Zeichnung konnte nicht geladen werden.')
    }
  }

  void render(ctx.host.theme)
  const unsubTheme = ctx.host.onThemeChange((t) => {
    void render(t)
  })

  return () => {
    disposed = true
    unsubTheme()
    container.textContent = ''
  }
}

// Font-Strategie (F01/F02): Excalidraws eigener CDN-Font-Loadpfad ist im Build (build.mjs) neutralisiert;
// die 3 Canvas-Default-Familien werden als data:-@font-face mitgeliefert (styles.css) und pro Editor-Mount
// via FontFace.load() vorgeladen (siehe oben), damit measureText echte Metriken bekommt. KEIN globaler
// FontFace-Prototype-Override mehr (der würde die eigenen data:-Fonts blockieren).
const plugin: PluginRendererModule = {
  id: 'mindgraph-excalidraw',
  activate(host) {
    host.log('Excalidraw-Plugin aktiviert')
    host.registerFileEditor({
      editorId: 'excalidraw',
      mount(container, ctx) {
        // Root PRO Mount (v0.2.0-Fix): eine geteilte Closure-Variable würde bei parallelen Mounts
        // (Editor-Tab + künftige Embeds, oder zwei Tabs) den jeweils anderen Root kapern.
        let root: Root | null = createRoot(container)
        root.render(<ExcalidrawEditor filePath={ctx.filePath} host={ctx.host} />)
        return () => {
          root?.unmount()
          root = null
        }
      },
    })
    // Read-only-Embed (R2) — feature-detected: ältere Hosts (API <0.2.1) kennen den Hook nicht,
    // dort läuft das Plugin unverändert ohne Inline-Vorschau (App zeigt den Fallback-Chip).
    host.registerFileEmbed?.({ editorId: 'excalidraw', mount: mountEmbed })
  },
}

export default plugin
