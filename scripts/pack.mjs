// Packt + signiert dist/ zu einem deterministischen, Ed25519-signierten .mgxplugin (tar.gz).
// Repliziert 1:1 das Format des App-Packers (app/src/main/plugins/artifact/pack.ts + format.ts):
//   integrity.json (sha256 je Datei, path-sortiert) → rohe Bytes signieren → integrity.json.sig
//   → deterministisches tar.gz (portable, gzip level 9).
//
// dist/ = das vollständige Artefakt (manifest.json + renderer.js + styles.css), von build.mjs erzeugt.
//
// Aufruf: node scripts/pack.mjs <dev-key.json> <out.mgxplugin>
//   <dev-key.json> liegt AUSSERHALB des Projekts und wird NIE committet.
import { createHash, sign as cryptoSign, createPrivateKey } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create as tarCreate } from 'tar'

const MANIFEST_FILE = 'manifest.json'
const INTEGRITY_FILE = 'integrity.json'
const SIG_FILE = 'integrity.json.sig'
const canon = (v) => Buffer.from(JSON.stringify(v, null, 2) + '\n', 'utf8')
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

async function pack({ files, signKey, keyId }) {
  const payload = [...files].sort(byPath)
  const entries = payload.map((f) => ({
    path: f.path,
    size: f.content.length,
    sha256: createHash('sha256').update(f.content).digest('hex'),
  }))
  const integrityBytes = canon({ formatVersion: 1, algorithm: 'sha256', files: entries })
  const signature = cryptoSign(null, integrityBytes, signKey)
  const sigBytes = canon({ formatVersion: 1, algorithm: 'ed25519', keyId, signature: signature.toString('base64') })
  const all = [
    ...payload,
    { path: INTEGRITY_FILE, content: integrityBytes },
    { path: SIG_FILE, content: sigBytes },
  ]
  const dir = mkdtempSync(join(tmpdir(), 'mgxpack-'))
  try {
    for (const f of all) writeFileSync(join(dir, f.path), f.content)
    const out = join(dir, '__artifact.tgz')
    await tarCreate({ gzip: { level: 9 }, portable: true, cwd: dir, file: out }, all.map((f) => f.path).sort())
    return readFileSync(out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Signierschlüssel + keyId — NUR lokal, mit einem Dev-Key zum Testen:
//   node scripts/pack.mjs <dev-key.json> <out.mgxplugin>
// Der <dev-key.json> liegt AUSSERHALB des Projekts und wird NIE committet. Offizielle Releases werden
// NICHT hier signiert, sondern zentral im mindgraph-notes-Workflow „Sign Plugin Release" — der private
// Prod-Schlüssel verlässt nie dessen geschütztes Environment und ist diesem Repo nie zugänglich.
const keyPath = process.argv[2]
const outPath = process.argv[3]
if (!keyPath || !outPath) {
  console.error('Aufruf: node scripts/pack.mjs <dev-key.json> <out.mgxplugin>')
  process.exit(1)
}
const keyJson = JSON.parse(readFileSync(keyPath, 'utf8'))
const signKey = createPrivateKey({ key: keyJson.privatePkcs8Pem, format: 'pem' })
const keyId = keyJson.keyId
const manifest = readFileSync(join('dist', MANIFEST_FILE))
const renderer = readFileSync(join('dist', 'renderer.js'))
const styles = readFileSync(join('dist', 'styles.css'))
const archive = await pack({
  files: [
    { path: MANIFEST_FILE, content: manifest },
    { path: 'renderer.js', content: renderer },
    { path: 'styles.css', content: styles },
  ],
  signKey,
  keyId,
})
writeFileSync(outPath, archive)
const version = JSON.parse(manifest.toString('utf8')).version
console.log(`Gepackt + signiert: ${outPath} (v${version}, ${archive.length} Bytes, keyId=${keyId})`)
