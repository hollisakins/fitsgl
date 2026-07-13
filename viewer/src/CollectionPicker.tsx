import { formatDec, formatRA, type Collection } from '@fitsgl/core';

/**
 * The collection landing page: a light grid of survey-field cards. Each card links
 * into that field's deployed viewer at `<name>/` (a sibling subdir under the deploy
 * root, where `name` is the field's deploy prefix). Pure presentation — the host
 * (`App`) probes + loads the `Collection`. `fieldHref` overrides the link target
 * per field name (the dev/preview app routes cards through its `?dataset=` param
 * instead of navigating away); omitted, the production-relative `<name>/` is used.
 */
export function CollectionPicker({
  collection,
  fieldHref,
}: {
  collection: Collection;
  fieldHref?: (name: string) => string;
}) {
  const n = collection.fields.length;
  return (
    <main className="picker">
      <header className="picker-head">
        <h1>{collection.collection.title ?? collection.collection.name}</h1>
        <p>
          {n} field{n === 1 ? '' : 's'}
        </p>
      </header>
      {n === 0 ? (
        <p className="picker-empty">No fields have been deployed yet.</p>
      ) : (
        <ul className="picker-grid">
          {collection.fields.map((f) => (
            <li key={f.name}>
              {/* Trailing slash → that field's index.html under the deploy root. */}
              <a
                className="field-card"
                href={fieldHref !== undefined ? fieldHref(f.name) : `${encodeURIComponent(f.name)}/`}
              >
                <span className="field-title">{f.title ?? f.name}</span>
                <span className="field-meta">
                  {f.bandCount !== undefined && (
                    <span>
                      {f.bandCount} band{f.bandCount === 1 ? '' : 's'}
                    </span>
                  )}
                  {f.center && (
                    <span className="field-pos">
                      {formatRA(f.center.ra)} {formatDec(f.center.dec)}
                    </span>
                  )}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
