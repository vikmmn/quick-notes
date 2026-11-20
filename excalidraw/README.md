Used only by the Obsidian vault importer (vault.html) to draw Excalidraw drawings as pictures.

- `excalidraw.js`: @excalidraw/excalidraw 0.18.0 (MIT licence, https://github.com/excalidraw/excalidraw) with React 18
  and lz-string (MIT), bundled with esbuild into one file that sets `window.QNExcalidraw`
  (`exportToSvg`, `exportToBlob`, `restore`, `lz`). The Mermaid converter is left out.
- `fonts/`: Excalidraw's fonts (Excalifont, Virgil, Cascadia, Nunito, Lilita One, Comic Shanns, Liberation Sans,
  Assistant), from the same package; their licences are the SIL Open Font License or MIT. The large Chinese/Japanese
  font (Xiaolai) is left out.

To rebuild: `npm i @excalidraw/excalidraw@0.18.0 react@18 react-dom@18 lz-string esbuild`, an entry file that imports
those and sets `window.QNExcalidraw`, then
`esbuild entry.js --bundle --minify --format=iife --define:process.env.NODE_ENV='"production"' --define:process.env.IS_PREACT='"false"' --loader:.woff2=empty --loader:.css=empty --alias:@excalidraw/mermaid-to-excalidraw=./stub.js`.
