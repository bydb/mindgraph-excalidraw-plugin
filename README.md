# MindGraph Excalidraw Plugin

Handgezeichneter Zeichen-Editor für `.excalidraw`-Dateien als signiertes **Renderer-Plugin** für
[MindGraph Notes](https://mindgraph-notes.de). Öffnet `.excalidraw`-Dateien im Vault in einem eigenen
Editor-Tab (Excalidraw 0.18.1), Speichern zurück in den Vault über die Plugin-Host-Vault-Bridge.

**Renderer-Plugin** (voller React-Canvas im Hauptfenster, signaturbasiertes Vertrauen). Setzt die
Renderer-Plugin-Host-Fähigkeit der App voraus (ab dem R1a-Host in `mindgraph-notes`).

## Fonts — vollständig lokal, keine Netz-Requests

Excalidraw lädt seine Handschrift-Fonts normalerweise vom `esm.sh`-CDN. Die App-CSP (`default-src 'self'`)
blockt das. Statt die Fonts wegzuschalten (was Text gegen System-Fallback misst → falsche, driftende
gespeicherte Geometrie), bettet der Build **alle 7 Nicht-CJK-Familien** (Excalifont, Nunito, Comic Shanns,
Virgil, Cascadia, Lilita One, Liberation Sans) mit **allen Subsets und originaler `unicode-range`** als
`data:`-`@font-face` ein → `measureText` trifft die echten Excalidraw-Metriken → portable, Cross-OS-konsistente
Koordinaten. Der `renderer.tsx`-Preload ist **fail-closed**: lädt eine Pflichtfamilie nicht, bleibt der Editor
schreibgeschützt statt falsche Geometrie zu speichern. Xiaolai (CJK, 12,8 MB) bleibt bewusst draußen.

Ein gehärtetes Build-Gate (`build.mjs`) erzwingt exakte Patch-Counts, Version-Pin auf Excalidraw `0.18.1`
und semantische Bundle-Asserts — bei Excalidraw-Update wird der Build rot statt still Fonts vom CDN zu laden.

## Lokaler Build + Signierung (Dev-Key, nur für Tests)

```bash
npm install
# Dev-Key AUSSERHALB des Projekts erzeugen (nie committen):
node scripts/keygen-dev.mjs /pfad/ausserhalb/dev-key.json
npm run build            # → dist/renderer.js + dist/styles.css + dist/manifest.json
node scripts/pack.mjs /pfad/ausserhalb/dev-key.json releases/excalidraw-$(node -p "require('./manifest.json').version").mgxplugin
```

Lokal installierbar nur in **ungepackten** App-Builds mit gesetztem `MINDGRAPH_PLUGIN_DEV_KEYRING_PATH`
(JSON `{ keyId: spkiPem }`). Gepackte Apps ignorieren Dev-Keys.

## Produktions-Release (zentral signiert)

Dieses Repo signiert **nicht selbst** — und bekommt den Prod-Schlüssel nie zu sehen. Offizielle Releases
werden zentral im Repo **mindgraph-notes** über den Workflow „Sign Plugin Release" signiert:

1. Hier nur **bauen + taggen**: `npm run build` erzeugt `dist/` (= `manifest.json` + `renderer.js` +
   `styles.css`); Commit taggen als `vX.Y.Z` und pushen. **Keine Secrets, kein Signier-Workflow hier.**
2. Ein Maintainer startet in **mindgraph-notes** den Workflow „Sign Plugin Release" (manuell, auf `master`)
   mit `repo` (`owner/repo`), `tag` und exaktem `commit_sha`.
3. Ein **untrusted Build-Job** (ohne Schlüssel) baut dieses Repo am Commit; ein **geschützter Signier-Job**
   im Environment `release-signing` signiert das gebaute `dist/` mit dem Prod-Key
   (keyId `mindgraph-release-2026-01`) und re-verifiziert das Archiv.
4. Das signierte `.mgxplugin` wird als Workflow-Artefakt erzeugt und ans GitHub-Release gehängt.

## Sicherheits-Leitplanken
- **Dev-Key ≠ Produktionsschlüssel.** Der private Prod-Key liegt ausschließlich im geschützten
  GitHub-Environment — nie im Repo. Nur sein Public Key ist in der App gepinnt (`OFFICIAL_KEYS`).
- Privates Schlüsselmaterial wird nie committet (`.gitignore` sperrt zusätzlich `*key*`/`*.pem`/`*secret*`).
- Single-File-ESM: `renderer.js` ist selbstenthalten (kein externer Import, kein `eval`/`new Function`) —
  der App-Packer weist ein nicht-selbstenthaltenes Bundle zurück.
