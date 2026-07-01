// build.mjs — esbuild Build-Adapter für das Excalidraw Renderer-Plugin.
//
// DER Knackpunkt (F01/F12): @excalidraw/excalidraw 0.18.1 enthält Font-Subsetting-
// Worker (WASM + new Function + import.meta.url), die vom Host-esmCheck terminal
// abgelehnt werden. Dieser Build-Adapter:
//  1. Intercept subset-worker.chunk.js + subset-shared.chunk.js → No-Op-Shims
//     (entfernt WASM/new Function aus dem Bundle — Font-Subsetting nur für Export)
//  2. define import.meta.url → "about:blank" (killt verbleibende import.meta.url)
//  3. CSS-Extraktion nach dist/styles.css (Host appliziert als <style>, kein F12)
//
// Akzeptanzkriterien (F09): exakt EIN JS-Output, assertSelfContainedEsm grün,
// keine externen Outputs, Größenmessung.

import * as esbuild from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const excalidrawDir = resolve(__dirname, 'node_modules/@excalidraw/excalidraw/dist/prod')

// ─── EMBEDDED_FONTS — statische Tabelle aller 7 Nicht-CJK-Familien + ihrer Subsets ───────────
// Extrahiert aus @excalidraw/excalidraw@0.18.1/dist/prod/chunk-K2UTITRG.js `static init()`.
// Jedes Subset wird als eigenes @font-face MIT der originalen unicode-range eingebettet,
// damit measureText exakt die gleichen Glyphen trifft wie echtes Excalidraw (F08/F09).
//
// Helvetica ist ein LOCAL-Font (uri:"local:") — kein woff2, wird vom Browser aufgelöst → nicht
// eingebettet. Xiaolai (CJK, 12,8 MB) und Segoe UI Emoji bewusst nicht eingebettet.
//
// Die `tn`-Konstanten (LATIN, LATIN_EXT, CYRILIC, CYRILIC_EXT, VIETNAMESE) sind direkt
// aus dem Source inline aufgelöst, damit die Tabelle keine Runtime-Parsung braucht.
//
// Familien ohne unicode-range im Descriptor (Cascadia, Virgil, Liberation Sans) bekommen
// KEIN `unicode-range` im @font-face → Browser nutzt die Font für alle Zeichen.
//
// Format: { family, filename, unicodeRange? }  — filename ist der reale Pfad unter fonts/.
export const EMBEDDED_FONTS = [
  // Cascadia — 1 Subset, keine unicode-range
  { family: 'Cascadia', filename: 'Cascadia/CascadiaCode-Regular.woff2' },

  // Comic Shanns — 4 Subsets
  { family: 'Comic Shanns', filename: 'ComicShanns/ComicShanns-Regular-279a7b317d12eb88de06167bd672b4b4.woff2',
    unicodeRange: 'U+20-7e,U+a1-a6,U+a8,U+ab-ac,U+af-b1,U+b4,U+b8,U+bb-bc,U+bf-cf,U+d1-d7,U+d9-de,U+e0-ef,U+f1-f7,U+f9-ff,U+131,U+152-153,U+2c6,U+2da,U+2dc,U+2013-2014,U+2018-201a,U+201c-201d,U+2020-2022,U+2026,U+2039-203a,U+2044,U+20ac,U+2191,U+2193,U+2212' },
  { family: 'Comic Shanns', filename: 'ComicShanns/ComicShanns-Regular-fcb0fc02dcbee4c9846b3e2508668039.woff2',
    unicodeRange: 'U+100-10f,U+112-125,U+128-130,U+134-137,U+139-13c,U+141-148,U+14c-151,U+154-161,U+164-165,U+168-17f,U+1bf,U+1f7,U+218-21b,U+237,U+1e80-1e85,U+1ef2-1ef3,U+a75b' },
  { family: 'Comic Shanns', filename: 'ComicShanns/ComicShanns-Regular-dc6a8806fa96795d7b3be5026f989a17.woff2',
    unicodeRange: 'U+2c7,U+2d8-2d9,U+2db,U+2dd,U+315,U+2190,U+2192,U+2200,U+2203-2204,U+2264-2265,U+f6c3' },
  { family: 'Comic Shanns', filename: 'ComicShanns/ComicShanns-Regular-6e066e8de2ac57ea9283adb9c24d7f0c.woff2',
    unicodeRange: 'U+3bb' },

  // Excalifont — 7 Subsets
  { family: 'Excalifont', filename: 'Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2',
    unicodeRange: 'U+20-7e,U+a0-a3,U+a5-a6,U+a8-ab,U+ad-b1,U+b4,U+b6-b8,U+ba-ff,U+131,U+152-153,U+2bc,U+2c6,U+2da,U+2dc,U+304,U+308,U+2013-2014,U+2018-201a,U+201c-201e,U+2020,U+2022,U+2024-2026,U+2030,U+2039-203a,U+20ac,U+2122,U+2212' },
  { family: 'Excalifont', filename: 'Excalifont/Excalifont-Regular-be310b9bcd4f1a43f571c46df7809174.woff2',
    unicodeRange: 'U+100-130,U+132-137,U+139-149,U+14c-151,U+154-17e,U+192,U+1fc-1ff,U+218-21b,U+237,U+1e80-1e85,U+1ef2-1ef3,U+2113' },
  { family: 'Excalifont', filename: 'Excalifont/Excalifont-Regular-b9dcf9d2e50a1eaf42fc664b50a3fd0d.woff2',
    unicodeRange: 'U+400-45f,U+490-491,U+2116' },
  { family: 'Excalifont', filename: 'Excalifont/Excalifont-Regular-41b173a47b57366892116a575a43e2b6.woff2',
    unicodeRange: 'U+37e,U+384-38a,U+38c,U+38e-393,U+395-3a1,U+3a3-3a8,U+3aa-3cf,U+3d7' },
  { family: 'Excalifont', filename: 'Excalifont/Excalifont-Regular-3f2c5db56cc93c5a6873b1361d730c16.woff2',
    unicodeRange: 'U+2c7,U+2d8-2d9,U+2db,U+2dd,U+302,U+306-307,U+30a-30c,U+326-328,U+212e,U+2211,U+fb01-fb02' },
  { family: 'Excalifont', filename: 'Excalifont/Excalifont-Regular-349fac6ca4700ffec595a7150a0d1e1d.woff2',
    unicodeRange: 'U+462-463,U+472-475,U+4d8-4d9,U+4e2-4e3,U+4e6-4e9,U+4ee-4ef' },
  { family: 'Excalifont', filename: 'Excalifont/Excalifont-Regular-623ccf21b21ef6b3a0d87738f77eb071.woff2',
    unicodeRange: 'U+300-301,U+303' },

  // Liberation Sans — 1 Subset, keine unicode-range
  { family: 'Liberation Sans', filename: 'Liberation/LiberationSans-Regular.woff2' },

  // Lilita One — 2 Subsets (tn.LATIN_EXT + tn.LATIN inline aufgelöst)
  { family: 'Lilita One', filename: 'Lilita/Lilita-Regular-i7dPIFZ9Zz-WBtRtedDbYE98RXi4EwSsbg.woff2',
    unicodeRange: 'U+0100-02AF, U+0304, U+0308, U+0329, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF' },
  { family: 'Lilita One', filename: 'Lilita/Lilita-Regular-i7dPIFZ9Zz-WBtRtedDbYEF8RXi4EwQ.woff2',
    unicodeRange: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD' },

  // Nunito — 5 Subsets (tn.* inline, weight:500 aus Descriptor übernommen)
  { family: 'Nunito', filename: 'Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTk3j6zbXWjgevT5.woff2',
    unicodeRange: 'U+0460-052F, U+1C80-1C88, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F', weight: '500' },
  { family: 'Nunito', filename: 'Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTA3j6zbXWjgevT5.woff2',
    unicodeRange: 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116', weight: '500' },
  { family: 'Nunito', filename: 'Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTs3j6zbXWjgevT5.woff2',
    unicodeRange: 'U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB', weight: '500' },
  { family: 'Nunito', filename: 'Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTo3j6zbXWjgevT5.woff2',
    unicodeRange: 'U+0100-02AF, U+0304, U+0308, U+0329, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF', weight: '500' },
  { family: 'Nunito', filename: 'Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTQ3j6zbXWjgeg.woff2',
    unicodeRange: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD', weight: '500' },

  // Virgil — 1 Subset, keine unicode-range
  { family: 'Virgil', filename: 'Virgil/Virgil-Regular.woff2' },
]

// Silent-Fail-Schutz: zählt, wie oft jeder Font-Neutralisierungs-Patch über ALLE onLoad'd Dateien matcht.
// Ein Excalidraw-Update kann Funktionsnamen/Minifizierung ändern → ein Regex matcht 0× → der Build bliebe
// grün, aber die esm.sh-Font-Fetches (+230 CSP-Fehler) kämen still zurück. Nach dem Build wird gegen erwartete
// Mindest-Counts + einen Post-Build-Grep asserted (Build rot bei Miss). Siehe Font-Shim-Gate in build().
const fontPatchCounts = { createUrls: 0, loadFontFaces: 0, fontsLoad: 0, fetchFont: 0, genFontFace: 0 }
function countReplace(code, re, repl, key) {
  const m = code.match(re)
  if (m) fontPatchCounts[key] += re.global ? m.length : 1
  return code.replace(re, repl)
}

// esbuild-Plugin: interceptiert die Font-Subsetting-Module und ersetzt sie durch No-Ops.
const fontSubsettingShimPlugin = {
  name: 'excalidraw-font-subsetting-shim',
  setup(build) {
    // subset-shared.chunk.js → no-op (verhindert Import von chunk-EIO257PC.js = WASM)
    build.onResolve({ filter: /subset-shared\.chunk\.js$/ }, (args) => ({
      path: resolve(__dirname, 'shims/subset-shared.js'),
    }))
    // subset-worker.chunk.js → no-op (verhindert import.meta.url + Worker-Erstellung)
    build.onResolve({ filter: /subset-worker\.chunk\.js$/ }, (args) => ({
      path: resolve(__dirname, 'shims/subset-worker.js'),
    }))

    // Excalidraw lädt zur Laufzeit ~230 Font-Subsets über einen hardcodierten esm.sh-CDN-Fallback
    // (`ASSETS_FALLBACK_URL`) — Host-CSP (default-src 'self') blockte sonst jede (230 Konsolen-Fehler).
    // Die 3 Canvas-Default-Familien liefern wir stattdessen LOKAL als data:-@font-face (siehe CSS-Sektion,
    // F01 → korrekte measureText-Metriken). Hier neutralisieren wir Excalidraws EIGENEN JS-Font-Ladepfad
    // (CDN) in 5 realen Schichten (KEIN ASSETS_FALLBACK_URL→''-Replace — leerer Base-URL kann `new URL`
    // werfen; die semantische Bundle-Assertion im Gate deckt das ab, F04):
    //
    // (1) createUrls → return[] — DIE WURZEL: die einzige Stelle, die new URL(uri, ASSETS_FALLBACK_URL)
    //     konstruiert. [] ⇒ `this.urls` leer ⇒ fetchFont/getContent unerreichbar; keine esm.sh-URLs.
    // (2) loadFontFaces → return[] — Bulk-Font-Loader (document.fonts.add) früh terminieren.
    // (3) document.fonts.load( → (async()=>[])( — die 2 Aufrufe in fontFacesLoader/loadElementsFonts.
    // (4) fetchFont → ganzer Rumpf Promise.reject (der einzige echte fetch()-Call; Caller fängt, F06).
    // (5) generateFontFaceDeclarations → return[] — SVG-Export-Font-CSS-Pfad abtöten.
    //
    // Ergebnis: 0 esm.sh-URLs, 0 CDN-fetch(), 0 CSP-Errors. Canvas-Text nutzt die eingebetteten data:-Fonts
    // (echte Excalifont/Nunito/Comic-Shanns-Metriken); seltene Nicht-Latin-1-Glyphen fallen auf System zurück.
    build.onLoad({ filter: /@excalidraw[/\\]excalidraw[/\\]dist[/\\]prod[/\\][^/\\]+\.js$/ }, (args) => {
      let code = readFileSync(args.path, 'utf8')

      // (1) createUrls → return[] (WURZEL — tötet alle URL-Konstruktion)
      code = countReplace(code, /(static createUrls\([^)]*\)\s*\{)/, '$1return[];', 'createUrls')

      // (2) loadFontFaces → return[] (kein document.fonts.add)
      code = countReplace(code, /(static async loadFontFaces\([^)]*\)\s*\{)/, '$1return[];', 'loadFontFaces')

      // (3) document.fonts.load( → (async()=>[])( (kein Font-Fetch via Font Loading API)
      code = countReplace(code, /(?:window\.)?document\.fonts\.load\(/g, '(async()=>[])(', 'fontsLoad')

      // (4) fetchFont → GANZER Rumpf terminiert (F06): nicht nur der innere fetch()-Ausdruck (minify-fragil),
      //     sondern die Methode früh via `return Promise.reject(...)`. Einziger Caller `getContent()` ruft
      //     fetchFont in try/catch → Rejection wird gefangen (keine unhandled rejection). In 0.18.1 ohnehin
      //     unerreichbar, weil createUrls→[] `this.urls` leert (belt-and-suspenders, minify-robuster).
      code = countReplace(
        code,
        /(\bfetchFont\([^)]*\)\s*\{)/,
        '$1return Promise.reject(new Error("font fetch disabled by build-shim"));',
        'fetchFont',
      )

      // (5) generateFontFaceDeclarations → return[] (SVG-Export-Font-CSS-Pfad abtöten)
      code = countReplace(code, /(static async generateFontFaceDeclarations\([^)]*\)\s*\{)/, '$1return[];', 'genFontFace')

      return { contents: code, loader: 'js' }
    })
  },
}

async function build() {
  mkdirSync(resolve(__dirname, 'dist'), { recursive: true })

  // --- 1. JS-Bundle ---
  const result = await esbuild.build({
    entryPoints: [resolve(__dirname, 'src/renderer.tsx')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    splitting: false,
    minify: true,
    jsx: 'automatic',
    sourcemap: false,
    target: ['es2022', 'chrome120'],
    outfile: resolve(__dirname, 'dist/renderer.js'),
    define: {
      'import.meta.url': JSON.stringify('about:blank'),
      // Excalidraw-Asset-Path: keine Font-Loads vom Server
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    plugins: [fontSubsettingShimPlugin],
    legalComments: 'none',
    logLevel: 'info',
    metafile: true,
  })

  // --- 2. CSS: Excalidraw-@font-face strippen, ALLE 7 Nicht-CJK-Familien als data: einbetten ---
  // F01/F08/F09 (Codex): Excalidraws Layout misst Text via canvas.measureText() gegen den TATSÄCHLICH
  // geladenen Font und schreibt x/y/width/height auf Platte. Ohne echte Metriken driften die gespeicherten
  // Koordinaten (Cross-Tool/Cross-OS, und die App synct Vaults). Darum betten wir ALLE 7 Nicht-CJK-Familien
  // (Excalifont, Nunito, Comic Shanns, Virgil, Cascadia, Lilita One, Liberation Sans) mit ALL ihren Subsets
  // JE als eigenes @font-face MIT originaler unicode-range ein → exakt gleiche Glyphen-Abdeckung wie echtes
  // Excalidraw → identische measureText-Werte. Helvetica ist LOCAL (vom Browser aufgelöst). Xiaolai (CJK,
  // 12,8 MB) bleibt draußen; seltene CJK-Zeichen fallen per-Glyph auf System zurück (dokumentierte Grenze).
  let dataFontFaces = ''
  let totalFontBytes = 0
  for (const { family, filename, unicodeRange, weight } of EMBEDDED_FONTS) {
    const fontPath = resolve(excalidrawDir, 'fonts', filename)
    if (!existsSync(fontPath)) {
      throw new Error(`[F08] Font-Datei fehlt: ${fontPath} — Excalidraw-Font-Layout geändert?`)
    }
    const b64 = readFileSync(fontPath).toString('base64')
    totalFontBytes += b64.length
    const ur = unicodeRange ? `unicode-range:${unicodeRange};` : ''
    const w = weight ? `font-weight:${weight};` : 'font-weight:400;'
    dataFontFaces += `@font-face{font-family:'${family}';${w}font-style:normal;font-display:swap;${ur}src:url(data:font/woff2;base64,${b64}) format('woff2')}\n`
  }
  console.log(`  Eingebettet: ${EMBEDDED_FONTS.length} @font-faces, ${(totalFontBytes / 1024).toFixed(0)} KB base64`)
  const excalidrawCssPath = resolve(excalidrawDir, 'index.css')
  let cssContent = readFileSync(excalidrawCssPath, 'utf-8')
  // Alle originalen @font-face (esm.sh/relative Font-URLs) restlos entfernen; Count fürs F03-Gate merken.
  const cssFaceStripCount = (cssContent.match(/@font-face\s*\{[^}]*\}/g) || []).length
  cssContent = `${dataFontFaces}${cssContent.replace(/@font-face\s*\{[^}]*\}/g, '')}`
  writeFileSync(resolve(__dirname, 'dist/styles.css'), cssContent)

  // Manifest neben die Entrypoints legen → dist/ = das vollständige Artefakt (manifest + entrypoints),
  // damit sowohl scripts/pack.mjs (Dev-Key) als auch der zentrale Prod-Signierer (ARTIFACT_DIR=dist) es 1:1 packen.
  writeFileSync(resolve(__dirname, 'dist/manifest.json'), readFileSync(resolve(__dirname, 'manifest.json')))

  // --- 3. Größen-Report (F09) ---
  const jsSize = statSync(resolve(__dirname, 'dist/renderer.js')).size
  const cssSize = statSync(resolve(__dirname, 'dist/styles.css')).size
  console.log('\n=== Build Report ===')
  console.log(`renderer.js: ${(jsSize / 1024 / 1024).toFixed(2)} MB (${jsSize.toLocaleString()} bytes)`)
  console.log(`styles.css:  ${(cssSize / 1024).toFixed(0)} KB (${cssSize.toLocaleString()} bytes)`)
  console.log(`Outputs:     ${result.metafile ? Object.keys(result.metafile.outputs).length : '?'} files`)

  // --- 4. F12-Selbsttest ---
  const jsCode = readFileSync(resolve(__dirname, 'dist/renderer.js'), 'utf-8')
  const violations = findEsmViolations(jsCode)
  if (violations.length > 0) {
    console.log('\n❌ F12-Violations (assertSelfContainedEsm würde ablehnen):')
    for (const v of violations) {
      console.log(`   - ${v.kind}${v.detail ? ` ('${v.detail}')` : ''}`)
    }
    process.exit(1)
  } else {
    console.log('\n✅ F12-Check: selbstenthaltenes Single-File-ESM — keine Violations')
  }

  // --- 5. Font-Shim-Gate (Silent-Fail-Schutz gegen Excalidraw-Updates) — fail-closed ---
  // F02: EXAKTE Patch-Counts für 0.18.1 (nicht nur ≥1 — ein Update, das den alten Pfad behält UND einen neuen
  // Loader einführt, verschiebt einen Count → rot) + Version-Pin. Semantik im finalen, minifizierten Bundle
  // (Excalidraws eigener Font-Loader ist per früh eingefügtem return dead-code-eliminiert). F03: CSS-Strip griff
  // + dist/styles.css enthält NUR unsere 3 data:-Faces, keine relative/http-Font-URL. F07: fonts.load == 2.
  const gateFail = []
  // (a) Version-Pin — der ganze Patch ist auf exakt 0.18.1 auditiert.
  const exVersion = JSON.parse(readFileSync(resolve(excalidrawDir, '../../package.json'), 'utf-8')).version
  if (exVersion !== '0.18.1') gateFail.push(`@excalidraw/excalidraw@${exVersion} ≠ 0.18.1 — Font-Patch neu auditieren`)
  // (b) exakte Patch-Counts
  const EXPECT_COUNTS = { createUrls: 1, loadFontFaces: 1, fontsLoad: 2, fetchFont: 1, genFontFace: 1 }
  for (const [key, exact] of Object.entries(EXPECT_COUNTS)) {
    if (fontPatchCounts[key] !== exact) gateFail.push(`Patch-Count ${key}=${fontPatchCounts[key]} (erwartet exakt ${exact})`)
  }
  // (c) semantische JS-Bundle-Asserts (dead code wegminifiziert)
  if (/(?:window\.)?document\.fonts\.load\(/.test(jsCode)) gateFail.push('lebendes document.fonts.load( im Bundle')
  if (/\.fonts\.add\(/.test(jsCode)) gateFail.push('lebendes .fonts.add( im Bundle')
  if (/Accept:\s*["']font\/woff2["']/.test(jsCode)) gateFail.push('lebender Font-fetch (Accept:font/woff2) im Bundle')
  // (d) CSS-Asserts (F03)
  const styleCss = readFileSync(resolve(__dirname, 'dist/styles.css'), 'utf-8')
  if (cssFaceStripCount < 1) gateFail.push('CSS-@font-face-Strip matchte 0× (erwartet ≥1)')
  const nonDataFontUrl = styleCss.match(/url\(\s*(?!["']?data:)[^)]*\.woff2?\b/gi)
  if (nonDataFontUrl) gateFail.push(`non-data Font-URL in styles.css: ${nonDataFontUrl[0].slice(0, 60)}`)
  const dataFaceCount = (styleCss.match(/@font-face\{font-family:'(?:Excalifont|Nunito|Comic Shanns|Cascadia|Lilita One|Liberation Sans|Virgil)'/g) || []).length
  if (dataFaceCount !== EMBEDDED_FONTS.length) gateFail.push(`eingebettete data:-Faces = ${dataFaceCount} (erwartet ${EMBEDDED_FONTS.length} = EMBEDDED_FONTS.length)`)
  if (gateFail.length) {
    console.log('\n❌ Font-Shim-Gate: Font-Neutralisierung/Einbettung unvollständig — Excalidraw-Update oder Regex-Drift?')
    for (const g of gateFail) console.log(`   - ${g}`)
    console.log('   → esm.sh-Fetches oder Metrik-Drift kämen sonst STILL zurück. build.mjs an die neue Excalidraw-Version anpassen.')
    process.exit(1)
  }
  console.log(
    `✅ Font-Shim-Gate: exakte Counts ok (createUrls:${fontPatchCounts.createUrls} loadFontFaces:${fontPatchCounts.loadFontFaces} ` +
      `fonts.load:${fontPatchCounts.fontsLoad} fetchFont:${fontPatchCounts.fetchFont} genFontFace:${fontPatchCounts.genFontFace}), ` +
      `${EMBEDDED_FONTS.length} data:-Faces in styles.css`,
  )
}

// --- Kopie des Host-esmCheck (R1a) für den Build-Spike ---
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:/])\/\/[^\n]*/g, '$1')
}

function findEsmViolations(rawCode) {
  const code = stripComments(rawCode)
  const out = []
  const BANNED = [
    { re: /\beval\s*\(/, kind: 'eval' },
    { re: /\bnew\s+Function\s*\(/, kind: 'new Function' },
    { re: /\bimport\.meta\.url\b/, kind: 'import.meta.url' },
  ]
  for (const b of BANNED) if (b.re.test(code)) out.push({ kind: b.kind })
  const isInline = (s) => s.startsWith('data:')
  const checkSpec = (spec, kind) => { if (!isInline(spec)) out.push({ kind, detail: spec }) }
  const STATIC_FROM = /(?:^|[\s;}])(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/g
  const SIDE_EFFECT = /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g
  const DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const m of code.matchAll(STATIC_FROM)) checkSpec(m[1], 'static-import')
  for (const m of code.matchAll(SIDE_EFFECT)) checkSpec(m[1], 'side-effect-import')
  for (const m of code.matchAll(DYNAMIC)) checkSpec(m[1], 'dynamic-import')
  return out
}

build().catch((err) => {
  console.error('Build failed:', err)
  process.exit(1)
})
