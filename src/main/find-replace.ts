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
  occurrences?: number
  oldPreview?: string
}

export interface FindReplacePatch {
  index: number
  from: number
  to: number
  oldLength: number
  newLength: number
  oldPreview: string
  newPreview: string
  diffPreview: string
}

export type FindReplaceResult =
  | {
      ok: true
      body: string
      appliedCount: number
      patches: FindReplacePatch[]
      diffPreview: string
    }
  | { ok: false; errors: FindReplaceFailure[] }

const PATCH_PREVIEW_CHARS = 500
const DIFF_PREVIEW_CHARS = 2_000
const AGGREGATE_DIFF_PREVIEW_CHARS = 6_000

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

function preview(text: string, max = PATCH_PREVIEW_CHARS): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= max ? compact : `${compact.slice(0, max)}...`
}

function diffPreview(oldText: string, newText: string): string {
  const diff = `- ${preview(oldText)}\n+ ${preview(newText)}`
  return diff.length <= DIFF_PREVIEW_CHARS ? diff : `${diff.slice(0, DIFF_PREVIEW_CHARS)}...`
}

function aggregateDiffPreview(patches: FindReplacePatch[]): string {
  const text = patches.map((patch) => `edit #${patch.index}\n${patch.diffPreview}`).join('\n\n')
  return text.length <= AGGREGATE_DIFF_PREVIEW_CHARS
    ? text
    : `${text.slice(0, AGGREGATE_DIFF_PREVIEW_CHARS)}...`
}

// Validate every edit against the ORIGINAL body before applying any of them,
// so a later edit's miss can't leave the doc in a half-applied state.
// Application is sequential on the running body, which is fine because each
// old_string was independently verified unique in the original; we don't try
// to handle edits whose old_string overlaps with a previous edit's new_string.
export function applyFindReplace(body: string, edits: FindReplaceEdit[]): FindReplaceResult {
  const errors: FindReplaceFailure[] = []
  const planned: Array<{ index: number; from: number; to: number; edit: FindReplaceEdit }> = []
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
        occurrences: count,
        oldPreview: preview(edit.old_string),
      })
    } else if (count > 1) {
      errors.push({
        index: i,
        reason: `\`old_string\` matches ${count} times — include more surrounding context to be unique`,
        occurrences: count,
        oldPreview: preview(edit.old_string),
      })
    } else {
      const from = body.indexOf(edit.old_string)
      planned.push({ index: i, from, to: from + edit.old_string.length, edit })
    }
  })
  if (errors.length > 0) return { ok: false, errors }

  const plannedByPosition = [...planned].sort((a, b) => a.from - b.from)
  for (let i = 1; i < plannedByPosition.length; i++) {
    const prev = plannedByPosition[i - 1]
    const current = plannedByPosition[i]
    if (current.from < prev.to) {
      errors.push({
        index: current.index,
        reason: `\`old_string\` overlaps edit #${prev.index}; split or combine the edits`,
        occurrences: 1,
        oldPreview: preview(current.edit.old_string),
      })
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  let next = body
  for (const { edit } of [...planned].sort((a, b) => a.index - b.index)) {
    next = next.replace(edit.old_string, edit.new_string)
  }
  const patches: FindReplacePatch[] = [...planned]
    .sort((a, b) => a.index - b.index)
    .map(({ index, from, to, edit }) => {
      const patchDiff = diffPreview(edit.old_string, edit.new_string)
      return {
        index,
        from,
        to,
        oldLength: edit.old_string.length,
        newLength: edit.new_string.length,
        oldPreview: preview(edit.old_string),
        newPreview: preview(edit.new_string),
        diffPreview: patchDiff,
      }
    })
  return {
    ok: true,
    body: next,
    appliedCount: edits.length,
    patches,
    diffPreview: aggregateDiffPreview(patches),
  }
}

export function formatFindReplaceErrors(errors: FindReplaceFailure[]): string {
  return errors.map((e) => `edit #${e.index}: ${e.reason}`).join('; ')
}
