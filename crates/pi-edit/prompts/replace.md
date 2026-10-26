Single file string replacement; fuzzy whitespace matching.

<instruction>
- MUST use smallest `old_string` uniquely identifying change.
- Nonunique `old_string` → MUST add context or use `replace_all: true` for all occurrences.
- Rename a string across file → use `replace_all: true`.
- SHOULD edit existing files, not create new.
</instruction>

<output>
Success/failure status.
Success: file modified in place; replacement applied.
Failure — e.g., `old_string` absent or multiple matches without `replace_all: true`: error describes issue.
</output>

<critical>
- MUST read file at least once in conversation before editing. Tool errors on edit before read.
</critical>

<bash-alternatives>
Replace content-addressed — identify change by text.

Pattern-addressed bulk changes: `sed -i`/`perl -i`/`awk -i inplace` are blocked in bash (not reviewable). Use `eval` (Python/JS) to rewrite the file, or `ast_edit` for structure-aware codemods.

Use Replace when content identifies location. For in-place single edits prefer Replace or `write` — diff preview and fuzzy matching.
</bash-alternatives>
