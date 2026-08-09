# Ringtome — Refactor Log

The forward-looking ledger of known compromises and queued cleanups. Tech debt is a mortgage
(STYLE.md): taking it on to ship is correct, as long as the balance is recorded here rather than
in anyone's memory. **Completed entries are deleted, not checked off** — git history is the
archive; this file is only ever the current balance.

Judge entries against STYLE.md; when one gets picked up, work it as its own commit-sized fix.

## Open items

### Sentences split by inline elements are catalogued as fragments

`node/tools/strings.mjs` parameterizes a value inside running text (`no entries match "{query}"`
is one message with one hole), but it cannot do that for an *element* inside running text. A
paragraph like idpage.js's `The path after <code>/id/</code> should be a persona's address` becomes
two catalog entries, and a translator gets two fragments rather than one sentence.

Why it matters: word order is the first thing that changes between languages, and a language that
wants the parts in the other order has no way to say so — the element is nailed between them. The
English reads fine, so this is invisible until someone actually translates.

The fix is rich-text interpolation: let a message hold element placeholders (`the path after
<code>{path}</code> should be…`) and have `t` return a vnode array rather than a string. That is a
real change to `t`'s contract and was deliberately not taken while the first catalog was being
built. Roughly a dozen sites; they are the entries in `en.js` that read as sentence halves.