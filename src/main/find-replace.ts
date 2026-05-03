// Atomic find/replace across multiple edits, shared by the file-based `edit`
// tool, the doc-aware `edit_doc` tool's offline path, and the renderer's
// CodeMirror transaction path. Same uniqueness contract everywhere:
//
//   - `old_string` must occur EXACTLY ONCE in the source body.
//   - If any edit fails uniqueness, NONE are applied (atomic).
//   - Empty `old_string` is invalid.
//
// Returns either `{ ok: true, body }` (the new content) or
// `{ ok: false, errors }` describing per-edit failures so callers can format
// them for tool output / UI.

export interface FindReplaceEdit {
  old_string: string
  new_string: string
}

export interface FindReplaceFailure {
  index: number
  reason: string
}

export type FindReplaceResult =
  | { ok: true; body: string; appliedCount: number }
  | { ok: false; errors: FindReplaceFailure[] }

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let from = 0
  while (true) {
    const idx = haystack.indexOf(needle, from)
    if (idx === -1) return count
    count++
    from = idx + needle.length
  }
}

// Validate every edit against the ORIGINAL body before applying any of them,
// so a later edit's miss can't leave the doc in a half-applied state.
// Application is sequential on the running body, which is fine because each
// old_string was independently verified unique in the original; we don't try
// to handle edits whose old_string overlaps with a previous edit's new_string.
export function applyFindReplace(body: string, edits: FindReplaceEdit[]): FindReplaceResult {
  const errors: FindReplaceFailure[] = []
  edits.forEach((edit, i) => {
    if (typeof edit.old_string !== 'string' || edit.old_string.length === 0) {
      errors.push({ index: i, reason: '`old_string` must be a non-empty string' })
      return
    }
    if (typeof edit.new_string !== 'string') {
      errors.push({ index: i, reason: '`new_string` must be a string' })
      return
    }
    const count = countOccurrences(body, edit.old_string)
    if (count === 0) {
      errors.push({
        index: i,
        reason: '`old_string` not found (must match byte-for-byte, including whitespace)',
      })
    } else if (count > 1) {
      errors.push({
        index: i,
        reason: `\`old_string\` matches ${count} times — include more surrounding context to be unique`,
      })
    }
  })
  if (errors.length > 0) return { ok: false, errors }

  let next = body
  for (const edit of edits) {
    next = next.replace(edit.old_string, edit.new_string)
  }
  return { ok: true, body: next, appliedCount: edits.length }
}

export function formatFindReplaceErrors(errors: FindReplaceFailure[]): string {
  return errors.map((e) => `edit #${e.index}: ${e.reason}`).join('; ')
}
