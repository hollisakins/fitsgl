# @fitsgl/core demo (React)

A minimal React page that renders a FITS pyramid through the `@fitsgl/core/react`
`<FitsViewer>` component — the M5 React delivery tier (decision D12). It reuses the
pyramid built by the vanilla [`demo/`](../demo) (served here with HTTP Range
support) and exercises both halves of the D12 boundary:

- **Controlled** `config: ViewerConfig` prop — the stretch curve, colormap,
  North-up, and single↔RGB toggles rebuild the config; the component diffs it and
  routes each change to the cheapest viewer call (no full reload for a display
  change).
- **Imperative** `ref` handle (`FitsViewerHandle`) — the _Auto-stretch_ / _Fit_
  buttons and the marker push (the catalog) go through the handle, the path a host
  like CAMPFIRE uses to drive a live, filtered marker set.

## Run

```bash
# 1) build a pyramid once, in the vanilla demo (writes demo/public/pyramid/)
cd ../demo && npm install && npm run build-pyramid

# 2) start the React harness (the pre-hooks rebuild the library first)
cd ../demo-react && npm install && npm run dev
```

Open the printed URL. A dataset (`dataset.json`) lights up the RGB toggle; a
single-band pyramid falls back to one grayscale band. The page is wrapped in
`<StrictMode>`, so the dev server also exercises the component's mount→unmount→mount
teardown.

## Layout

- `src/App.tsx` — discovers the pyramid (`dataset.json` or `manifest.json` + an
  optional `catalog.csv`), builds the controlled `ViewerConfig` from React state,
  and drives markers/actions through the ref handle.
- `vite.config.ts` — serves `../demo/public/pyramid/*` (Range-aware for `.fits.fz`)
  and aliases `@fitsgl/core` + `@fitsgl/core/react` to the library's `dist/`.
