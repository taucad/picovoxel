// The coverage-ignore audit behind the browser gate: every directive the coverage
// converter (ast-v8-to-istanbul@1.0.5) honours needs a ` -- <reason>` on its line.
// The converter reads if/else/next/file at the start of a comment, after any
// `//`, `/*` or `/**` opener, and start/stop anywhere on a source line, so the
// audit checks every line for any of them, a superset of both. A `stop` only
// closes a justified `start`, so it needs no reason of its own.
const DIRECTIVE = /(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(?:if|else|next|file|start)(?=\W|$)/u;

/**
 * Lists the coverage-ignore directives in a source text that carry no reason.
 *
 * @param {string} source - The file text.
 * @returns {string[]} Each offending line, trimmed.
 */
export function unjustifiedIgnores(source) {
  return source
    .split(/\r?\n/u)
    .filter((line) => {
      const match = DIRECTIVE.exec(line);
      return match !== null && !/\s--\s+\w/u.test(line.slice(match.index + match[0].length));
    })
    .map((line) => line.trim());
}
