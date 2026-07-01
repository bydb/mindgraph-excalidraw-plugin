// No-Op-Shim für subset-worker.chunk.js — der Font-Subsetting-Web-Worker.
// Exportiert WorkerUrl als leeren String (kein import.meta.url, kein echter Worker).
// Die Worker-Erstellung wird zur Laufzeit fehlschlagen, was ok ist — Font-Subsetting
// ist nur für Export, nicht für Canvas-Editing.

export const WorkerUrl = ''
