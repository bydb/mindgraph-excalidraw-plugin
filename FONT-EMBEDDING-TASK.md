# Auftrag an Hermes: Multi-Familie-Font-Embedding (Codex F08 + F09)

**Von Claude/Opus (Lead). Kontext:** Codex hat meinen ersten F01-Fix (3 Familien, je größte Subset-Datei,
KEINE unicode-range) adversarial re-reviewt und zwei echte Lücken gefunden:

- **F09 (kritisch):** Excalidraw 0.18.1 kennt neben Excalifont/Nunito/Comic Shanns auch **Virgil** (Legacy-
  Handschrift), **Cascadia**, **Lilita One**, **Liberation Sans**. Bestehende/importierte `.excalidraw`-Dateien
  können diese `fontFamily`-IDs nutzen. Da Excalidraws JS-Font-Loader global neutralisiert ist, werden alle
  NICHT eingebetteten Familien wieder gegen System-Fallback gemessen → falsche persistierte Textgeometrie.
- **F08 (hoch):** „Größte Datei = Latin-Kern" ist eine unbewiesene Heuristik; und die größten Subsets haben
  absichtliche Lücken INNERHALB Latin-1 (z.B. Excalifont ohne U+00A4/U+00A7, Comic Shanns ohne U+00D0/U+00D8).
  Ohne `unicode-range` fällt der Browser für diese einzelnen Zeichen per-Glyph auf System zurück → inkonsistente
  Metrik. Nur wenn wir jedes Subset MIT seiner originalen `unicode-range` einbetten, deckt sich die Font-
  Abdeckung exakt mit echtem Excalidraw → identische measureText-Werte.

## Deine Aufgabe (NUR die CSS-Embedding-Sektion in `build.mjs`)

Ersetze die aktuelle `CANVAS_FONTS`-Schleife (3 Familien, größte Datei, ohne unicode-range) durch:

**Alle Nicht-CJK-Familien, ALLE ihre Subsets, jedes als eigenes `@font-face` MIT seiner originalen
`unicode-range`** — extrahiert aus Excalidraws `static init()`-Descriptors (dein disassembliertes Terrain).

- **Familien (7, ~480 KB gesamt — machbar):** Excalifont, Nunito, Comic Shanns, Virgil, Cascadia, Lilita One,
  Liberation Sans. **Xiaolai (CJK, 12,8 MB) NICHT einbetten** (separater Ausgang, mache ich).
- **Font-Familie-Namen:** exakt die Strings, die Excalidraw für `context.font`/measureText nutzt (verifiziere
  gegen den Code — z.B. `Excalifont`, `Nunito`, `Comic Shanns`, `Virgil`, `Cascadia`, `Lilita One`,
  `Liberation Sans`). Der `@font-face`-`font-family` muss exakt matchen, sonst greift measureText die data:-Font
  nicht.
- **Pro Subset:** `@font-face{font-family:'<Name>';font-weight:400;font-style:normal;font-display:swap;
  unicode-range:<ORIGINAL aus dem Descriptor>;src:url(data:font/woff2;base64,<...>) format('woff2')}`. Die
  `uri→unicodeRange`-Zuordnung kommt aus den Descriptor-Arrays (`var xy=[{uri:...,descriptors:{unicodeRange:
  "U+20-7e,…"}},…]`) im minifizierten `node_modules/@excalidraw/excalidraw/dist/prod/*.js`. Die `uri` ist der
  Pfad `./fonts/<Familie>/<Datei>.woff2`.
- **Deterministisch, nicht nach Größe:** baue eine Tabelle Familie → [{datei, unicodeRange}] direkt aus den
  Descriptors. Wenn eine Familie/ein Descriptor nicht gefunden wird → `throw` (fail-closed, kein stiller Teil-
  Erfolg). Exportiere die Liste der eingebetteten (family, filename)-Paare als `export const EMBEDDED_FONTS`
  am Modulanfang von build.mjs, damit ich sie im Gate pinnen kann.

## Grenzen (bitte strikt)

- **NUR** die CSS-Embedding-Sektion in `build.mjs`. **NICHT** das Font-Shim-Gate anfassen (Abschnitt „Font-Shim-
  Gate" — das pinne ich auf deine `EMBEDDED_FONTS`-Liste), **NICHT** `src/renderer.tsx` (den fail-closed Preload
  F10 baue ich).
- Eigenes Repo `~/dev/mindgraph-excalidraw-plugin`, **kein Commit**, F12-Selbsttest muss grün bleiben
  (`node build.mjs`). styles.css darf auf ~640 KB wachsen (ok).
- Poste kurz: die extrahierte Familie→Subset/Range-Tabelle + bestätige `node build.mjs` grün. Ich verifiziere
  live (Virgil-Szene, present+fehlende Zeichen) und baue F10 + Gate-Pinning.
