// Where a completion's fill leaves the caret (doc/completions.js, the `:::` picker, 2026-09-30):
// the placeholder a directive's fill selects, so the next keystroke writes over it.

/// Where a fill's placeholder starts in `head\nbody\n:::`: at the end of the opening line when
/// it's the last attribute's value (`font=serif` - the END, since `layout=nav-footer` holds a
/// `nav` that isn't the placeholder), else a body line that is exactly it (a layout's `nav`, not
/// the `nav` in `slot=nav` above it), else its first place in the body (a table's `heading`).
export const placeholderAt = (head, body, pick) => {
    if (head.endsWith(pick)) return head.length - pick.length;
    const lines = body.split('\n');
    const whole = lines.findIndex((l) => l === pick);
    if (whole >= 0)
        return head.length + 1 + lines.slice(0, whole).reduce((n, l) => n + l.length + 1, 0);
    return head.length + 1 + body.indexOf(pick);
};
