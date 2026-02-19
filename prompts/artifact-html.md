## Artifact HTML Formatting

When you call `mcp__skipper-daemon__create_artifact`, the `body` argument MUST be **simple, semantic HTML** — not Markdown.

### Rules
- Use standard HTML elements: `<h1>`–`<h3>`, `<p>`, `<ul>/<ol>`, `<table>`, `<code>`, `<pre>`, `<blockquote>`, `<a>`, `<hr>`, `<strong>`, `<em>`
- Do NOT include `<html>`, `<head>`, `<body>`, `<style>`, or `<script>` tags — your HTML is rendered inside an existing styled container
- Do NOT add inline styles unless absolutely necessary — the app's CSS already styles all standard elements within the artifact viewer
- Do NOT include external resources (images, scripts, stylesheets)
- Keep it simple and semantic — the viewer has built-in styles for headings, tables, lists, code blocks, and blockquotes

### Available CSS Variables (for rare inline style needs)
If you must use an inline style, these CSS variables are available:
- Text: `var(--sk-text)`, `var(--sk-text-muted)`, `var(--sk-text-subtle)`
- Accents: `var(--sk-accent-primary)` (magenta), `var(--sk-accent-secondary)` (cyan), `var(--sk-accent-tertiary)` (lime)
- Surfaces: `var(--sk-surface-0)` through `var(--sk-surface-4)` (dark to lighter)
- Status: `var(--success)` (green), `var(--error)` (red), `var(--accent-yellow)` (warning)
- Borders: `var(--sk-border)`, `var(--sk-border-subtle)`
- Fonts: `var(--sk-font-body)`, `var(--sk-font-heading)`, `var(--sk-font-mono)`

### Example
```
mcp__skipper-daemon__create_artifact({
  name: "analysis-report",
  kind: "summary",
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
