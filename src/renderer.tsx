// MindGraph Excalidraw Renderer-Plugin — Default-Export-Modul (R1b).
//
// Vertrag (R1a, @mindgraph/plugin-api): export default { id, activate(host), deactivate?() }
// host.registerFileEditor({ editorId, mount }) — mount(container, { filePath, host }) => dispose
//
// Dies ist der Build-Spike: importiert @excalidraw/excalidraw um zu verifizieren,
// dass der Build-Adapter (build.mjs) ein F12-taugliches Single-File-ESM erzeugt.
// Die volle Editor-Logik (Save-Controller, UIOptions-Lockdown, Error-States) kommt
// nach dem Spike.

import { Excalidraw } from '@excalidraw/excalidraw'
import { createRoot } from 'react-dom/client'
import React from 'react'

export default {
  id: 'mindgraph-excalidraw',
  activate(host) {
    host.log('Excalidraw-Plugin aktiviert (Build-Spike)')

    host.registerFileEditor({
      editorId: 'excalidraw',
      mount(container, ctx) {
        const root = createRoot(container)
        root.render(
          React.createElement(ExcalidrawEditor, { filePath: ctx.filePath, host: ctx.host })
        )
        return () => root.unmount()
      },
    })
  },
}

// Minimaler Editor für den Spike — volle Logik folgt nach F12-Grün.
function ExcalidrawEditor({ filePath, host }) {
  const [initialData, setInitialData] = React.useState(null)

  React.useEffect(() => {
    host.vault.exists(filePath).then((exists) => {
      if (!exists) { setInitialData({ elements: [], appState: {} }); return }
      host.vault.read(filePath).then((content) => {
        try { setInitialData(JSON.parse(content)) }
        catch { setInitialData({ elements: [], appState: {} }) }
      })
    })
  }, [filePath])

  if (!initialData) return React.createElement('div', null, 'Lädt …')

  return React.createElement(Excalidraw, {
    initialData,
    UIOptions: {
      canvasActions: {
        loadScene: false,
        saveToActiveFile: false,
        export: { saveFileToDisk: false },
      },
    },
  })
}
