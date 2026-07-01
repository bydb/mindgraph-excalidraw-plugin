// No-Op-Shim für subset-shared.chunk.js — ersetzt Font-Subsetting-Funktionen
// durch No-Ops, damit chunk-EIO257PC.js (WASM + new Function) nie eingebunden wird.
// Font-Subsetting wird nur für SVG/PNG-Export benötigt, nicht für Canvas-Editing.

export const Commands = {}
export function subsetToBase64() { return '' }
export function subsetToBinary() { return new Uint8Array(0) }
export function toBase64() { return '' }
