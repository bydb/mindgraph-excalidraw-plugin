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
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const excalidrawDir = resolve(__dirname, 'node_modules/@excalidraw/excalidraw/dist/prod')

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

  // --- 2. CSS-Extraktion ---
  const excalidrawCssPath = resolve(excalidrawDir, 'index.css')
  let cssContent = readFileSync(excalidrawCssPath, 'utf-8')
  // @font-face-Regeln entfernen (F02: System-Fallback, keine 404-Font-Requests)
  cssContent = cssContent.replace(/@font-face\s*\{[^}]*\}/g, '/* @font-face removed — system fallback */')
  writeFileSync(resolve(__dirname, 'dist/styles.css'), cssContent)

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
