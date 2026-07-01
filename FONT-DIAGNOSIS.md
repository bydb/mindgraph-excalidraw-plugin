# Font-Handoff (F02) — Diagnose von Claude/Opus (Lead), Fix gesucht von Hermes

**Kontext:** Excalidraw-Renderer-Plugin (R1b) lädt live in MindGraph (R1a-Host). Canvas rendert/zeichnet/
speichert **einwandfrei** (Save-Controller verifiziert). **Einziges offenes Problem:** 230 Konsolen-Fehler
`Loading the font 'https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/fonts/...woff2' violates CSP
"default-src 'self'"`. Nicht-fatal (System-Fallback greift), aber wir wollen sie **sauber weg** — ohne
Netzwerk, F12-tauglich (Single-File-ESM: kein import.meta.url / new Function / eval / relative|bare imports),
im Build-Adapter (`build.mjs`), nicht als Host-CSP-Lockerung Richtung CDN.

## Root Cause (empirisch belegt)

1. Excalidraws Font-Source-Builder hängt an JEDE Font-URL-Liste **immer** einen Fallback an:
   `return r.push(new URL(n, ASSETS_FALLBACK_URL)), r` — und `ASSETS_FALLBACK_URL = https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/`.
   Also selbst wenn `window.EXCALIDRAW_ASSET_PATH` gesetzt ist, bleibt esm.sh als Quelle drin → CSP-Block.
2. ~20 Font-Familien × Unicode-Subsets = **230** Requests, feuern beim **Text-Rendering** (Zeichnen + Text-Tool).
3. **Der Skip-Hebel** (wichtig!): `fontFacesLoader` macht pro Font
   `window.document.fonts.check(fontShorthand, chars) || (yield ...load...)`
   → **wenn `check()` true ist (Font verfügbar), wird NICHT geladen.** Das ist der sauberste Ansatzpunkt.

## Was ich schon versucht habe — und warum es NICHT reicht (bitte nicht wiederholen)

Alle Patches sind im gebauten Bundle verifiziert gelandet, Fehler bleiben trotzdem 230:

- **`loadFontFaces` → `return []`** (esbuild onLoad). Ergebnis: **0 `.fonts.add` im Bundle** (bestätigt) — die
  Bulk-Registrierung ist tot. Trotzdem 230.
- **`document.fonts.load(` → `(async()=>[])(`** (beide Aufrufstellen). Ergebnis: **0 `document.fonts.load` im
  Bundle**. Trotzdem 230. ⇒ Der Fetch läuft NICHT (nur) über `document.fonts.load`.
- **`FontFace.prototype.load` global no-oppen** (Plugin activate, scoped, restore bei deactivate). Laufzeit-
  Diagnose bestätigt Override aktiv (`FontFace.prototype.load.toString()` == `function(){return Promise.resolve(this)}`).
  **Greift NICHT** ⇒ Fetch läuft auch NICHT über `FontFace.load()`.
- **CSS `@font-face` in styles.css gestrippt** (0 `url(...woff2)` im gebauten styles.css bestätigt).

## Laufzeit-Diagnose (DevTools-Konsole, live)

```
document.fonts.size            => 20   // ALLE 20 sind KaTeX_* (Host-eigene Math-Fonts) — Red Herring!
CSSFontFaceRule im DOM         => 20   // ebenfalls alle KaTeX, in einem <style> (href null)
```

⇒ Zum Zeitpunkt des Snapshots sind Excalidraws @font-face-Regeln **NICHT** im DOM. Schlussfolgerung: Excalidraw
injiziert seine `@font-face`-Regeln (esm.sh-URLs) **transient** rund um `document.fonts.check()`/Font-Messung,
der Browser fetcht implizit (→ CSP-Block), danach ist die Regel wieder weg. Deshalb greifen `.load()`-Override
und `document.fonts.load`-Patch nicht (impliziter Browser-Fetch, kein expliziter API-Call).

## Die konkrete Frage an dich (Hermes)

Finde den **exakten** Injektions-/Fetch-Pfad in `@excalidraw/excalidraw@0.18.1/dist/prod/` (index.js + chunks)
und einen **sauberen, F12-tauglichen Build-Patch** (in `build.mjs` via esbuild onLoad-Regex), der eines erreicht:

- **(bevorzugt) `check()` befriedigen ohne Netzwerk:** Excalidraws Familien so registrieren/aliassen, dass
  `document.fonts.check(...)` true liefert → Skip. Ideal via System-Font-Alias (0 Bytes) statt 13 MB data:-inline.
  Frage: Lädt Excalidraw wirklich EAGER alle 20 Familien, oder nur die der Szene? Wenn nur Szene → data:-inline
  von Excalifont/Nunito/Comic Shanns (klein) könnte reichen.
- **oder** die transiente `@font-face`-Injektion / den Font-Descriptor-Pfad an der Wurzel neutralisieren
  (System-Fallback, 0 Fetch-Versuche, 0 Konsolen-Fehler).

Constraints: kein `font-src`-CDN-Opening im Host, kein Netzwerk, Bundle bleibt Single-File-ESM (F12), Fix
gehört in `build.mjs`/`shims/` (nicht in den Host). Bitte KEINE Core-App-Änderungen und NICHT auf
`feat/plugin-renderer-host` committen — Repo ist `~/dev/mindgraph-excalidraw-plugin` (eigenes git).

Wenn du einen Kandidaten hast: kurz die Mechanik erklären + den Patch. Ich (Claude) verifiziere live (isoliertes
Profil, `document.fonts`-Diagnose, Fehlerzähler) und lasse Codex den Ansatz adversarial gegenchecken.
