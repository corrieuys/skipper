## Artifact Formatting

When you call `mcp__skipper-daemon__create_artifact`, you MUST pass a `format`
field alongside `body`. Choose the format based on how complex the content is:

- **`format: "markdown"`** — the default choice. Use for prose, notes,
  summaries, plans, checklists, and any document that is mostly headings,
  paragraphs, lists, inline code, and simple tables. Write the `body` as plain
  GitHub-flavoured Markdown.
- **`format: "html"`** — use only when Markdown renders the content poorly:
  multi-column or spanning tables, nested structures, or layouts that need
  precise element control. Write the `body` as simple, semantic HTML.

If in doubt, prefer `markdown`. Reach for `html` only when the structure
genuinely needs it.

### HTML rules (only when `format: "html"`)
The body is **structurally validated before it is saved**. If the HTML is
malformed the tool call is **rejected** with the exact tag and the line/column
where the node tree broke — fix it and retry. To pass validation:

- Every element must be correctly nested and closed (`<ul><li>…</li></ul>`, not
  `<ul><li>…</ul>`). Unclosed or mismatched tags are rejected.
- Use standard elements: `<h1>`–`<h3>`, `<p>`, `<ul>/<ol>/<li>`, `<table>` (with
  `<thead>/<tbody>/<tr>/<th>/<td>`), `<code>`, `<pre>`, `<blockquote>`, `<a>`,
  `<hr>`, `<strong>`, `<em>`, `<br>`.
- Do NOT include `<html>`, `<head>`, `<body>`, `<style>`, `<script>`, `<iframe>`,
  or `<object>` tags — these are rejected. Your HTML renders inside an existing
  styled container.
- Escape literal angle brackets inside text/code as `&lt;` / `&gt;` so they are
  not parsed as tags.
- Do NOT include external resources (images, scripts, stylesheets) and avoid
  inline styles unless absolutely necessary — the viewer already styles all
  standard elements.

### Available CSS Variables (for rare inline style needs)
If you must use an inline style, these CSS variables are available:
- Text: `var(--sk-text)`, `var(--sk-text-muted)`, `var(--sk-text-subtle)`
- Accents: `var(--sk-accent-primary)` (magenta), `var(--sk-accent-secondary)` (cyan), `var(--sk-accent-tertiary)` (lime)
- Surfaces: `var(--sk-surface-0)` through `var(--sk-surface-4)` (dark to lighter)
- Status: `var(--success)` (green), `var(--error)` (red), `var(--accent-yellow)` (warning)
- Borders: `var(--sk-border)`, `var(--sk-border-subtle)`
- Fonts: `var(--sk-font-body)`, `var(--sk-font-heading)`, `var(--sk-font-mono)`

### Examples

Markdown (simple content — the common case):
```
mcp__skipper-daemon__create_artifact({
  name: "auth-findings",
  kind: "summary",
  format: "markdown",
  description: "Auth review notes",
  body: `## Auth Review

Three issues found:

- Session tokens never expire
- Password reset lacks rate limiting
- CSRF token is reused across forms

**Recommendation:** rotate tokens on privilege change.`
})
```

HTML (complex table — needs precise structure):
```
mcp__skipper-daemon__create_artifact({
  name: "coupling-analysis",
  kind: "summary",
  format: "html",
  description: "Component coupling analysis",
  body: `<h2>Component Coupling Analysis</h2>
<p>Found <strong>3 high-coupling</strong> areas requiring attention:</p>
<table>
  <thead><tr><th>Module</th><th>Dependencies</th><th>Risk</th></tr></thead>
  <tbody>
    <tr><td>AuthService</td><td>7</td><td><strong>High</strong></td></tr>
    <tr><td>UserManager</td><td>5</td><td>Medium</td></tr>
    <tr><td>EventBus</td><td>3</td><td>Low</td></tr>
  </tbody>
</table>
<blockquote>Recommendation: Extract shared interfaces to reduce AuthService coupling.</blockquote>`
})
```

## File Artifacts

`create_artifact` is for text you write inline (markdown or html). For anything
that already exists as a file on disk, call
`mcp__skipper-daemon__create_file_artifact({ name, path, description? })`:

- Screenshots you took (browser, simulator, emulator, desktop), photos, rendered
  charts or diagrams, PDFs, spreadsheets, archives, build outputs, or any other
  binary the operator should see or keep.
- `path` is the absolute path on this machine. The daemon copies the file into
  the task's artifact store (25 MB cap), so the file may be deleted afterwards.
- `name` is the filename the operator sees (keep the extension). Re-using a
  name creates a new version, which is the right way to show a before/after.
- `description` is a short caption: what the file shows and why it matters.

The artifact appears on the task timeline and in the Artifacts panel on every
Skipper surface, including the mobile apps, where images render as pictures.
It is NOT fed back to you as input; it is your output for the operator and for
other agents, who can find it with `list_artifacts` (rows with `storage: "file"`)
and open its `path` from `get_artifact` with their own file or image tool.

Attach a screenshot whenever you verified something visually: the operator can
then see what you saw instead of taking your word for it.
