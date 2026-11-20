import { Fragment } from "react";

export function DecryptText({ text }: { text: string }) {
  return (
    <span className="decrypt-label">
      <span className="sr-only">{text.replaceAll("\n", " ")}</span>
      <span aria-hidden="true">
        {text.split("\n").map((line, index) => (
          <Fragment key={line}>
            {index > 0 && <br />}
            {Array.from(line, (char, i) =>
              /[A-Z]/.test(char) ? (
                <span className="decrypt-letter" key={i}>
                  {char}
                </span>
              ) : (
                char
              ),
            )}
          </Fragment>
        ))}
      </span>
    </span>
  );
}
