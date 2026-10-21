import { Fragment } from "react";

const PLACEHOLDER = /(\[TO CONFIRM:[^\]]*\])/g;

/** Inline text with [TO CONFIRM: …] placeholders highlighted. */
export function Highlighted({ text }: { text: string }) {
  return (
    <>
      {text.split(PLACEHOLDER).map((part, i) =>
        part.startsWith("[TO CONFIRM:") ? (
          <mark key={i} className="tbc">
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

export function countPlaceholders(text: string): number {
  return text.match(PLACEHOLDER)?.length ?? 0;
}
