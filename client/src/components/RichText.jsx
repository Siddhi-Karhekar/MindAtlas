import { Fragment, useMemo } from "react";
import MathText from "./MathText.jsx";
import { parseRichText } from "../lib/richText.js";

// A question, an option or an answer as it should read: formulas typeset,
// code in a monospaced face, line breaks kept (lib/richText.js says what is
// understood). Everything is rendered as text by React; the only HTML is
// KaTeX's, inside MathText.
//   inline  for one line inside other text (an option, a cloze part): no
//           block margins, code blocks shown inline
export default function RichText({ text, inline = false, className = "" }) {
  const blocks = useMemo(() => parseRichText(text), [text]);
  const Wrapper = inline ? "span" : "div";
  return (
    <Wrapper className={className} data-testid="rich-text">
      {blocks.map((b, i) =>
        b.type === "code" ? (
          inline ? (
            <code key={i} className="font-mono text-[0.92em] px-1 rounded bg-surface-container-high">
              {b.text}
            </code>
          ) : (
            <pre key={i} className="my-space-sm p-space-md rounded-lg bg-surface-container-high text-left overflow-x-auto font-mono text-[0.85em] leading-relaxed whitespace-pre" data-testid="rich-code">
              <code>{b.text}</code>
            </pre>
          )
        ) : (
          <Fragment key={i}>
            {b.lines.map((segments, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {segments.map((seg, k) =>
                  seg.type === "code" ? (
                    <code key={k} className="font-mono text-[0.92em] px-1 rounded bg-surface-container-high">
                      {seg.text}
                    </code>
                  ) : seg.type === "bold" ? (
                    <strong key={k}>
                      <MathText text={seg.text} />
                    </strong>
                  ) : (
                    <MathText key={k} text={seg.text} />
                  )
                )}
              </Fragment>
            ))}
          </Fragment>
        )
      )}
    </Wrapper>
  );
}
