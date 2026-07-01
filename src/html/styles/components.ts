/** Core component styles: badges, buttons, forms, tables */
export function componentStyles(): string {
  return `
    /* ── Theme picker ── */
    .sk-theme-picker {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      font-size: var(--sk-text-xs);
      color: var(--sk-text-muted);
    }
    .sk-theme-picker__select {
      padding: 0.25rem 0.45rem;
      font-size: var(--sk-text-xs);
      background: var(--sk-surface-2);
      color: var(--sk-text);
      border: 1px solid var(--sk-border-subtle);
      border-radius: var(--sk-radius-sm);
      cursor: pointer;
    }
    .sk-theme-picker__select:hover { border-color: var(--sk-border-active); }
    .sk-select--sm { padding: 0.25rem 0.45rem; font-size: var(--sk-text-xs); }

    /* ── Badges ── */
    .sk-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.3em;
      padding: 0.15em 0.5em;
      border-radius: var(--sk-radius-sm);
      font-size: var(--sk-text-xs);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }
    .sk-badge--running  { background: rgba(0, 251, 251, 0.15); color: var(--sk-accent-secondary); }
    .sk-badge--completed { background: rgba(176, 255, 150, 0.15); color: var(--sk-accent-tertiary); }
    .sk-badge--failed   { background: rgba(255, 107, 107, 0.15); color: var(--sk-accent-danger); }
    .sk-badge--approved  { background: rgba(255, 208, 128, 0.15); color: var(--sk-accent-warning); }
    .sk-badge--draft    { background: rgba(173, 170, 170, 0.1); color: var(--sk-text-muted); }
    .sk-badge--pending  { background: rgba(173, 170, 170, 0.1); color: var(--sk-text-muted); }
    .sk-badge--waiting  { background: rgba(255, 137, 171, 0.15); color: var(--sk-accent-primary); }
    .sk-badge--danger   { background: rgba(255, 107, 107, 0.2); color: var(--sk-accent-danger); }
    .sk-badge--nav      { font-size: 0.65rem; min-width: 1.4em; text-align: center; }

    /* ── Buttons ── */
    .sk-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.4em;
      min-height: var(--sk-btn-height);
      padding: var(--sk-btn-pad-y) var(--sk-btn-pad-x);
      border: 1px solid var(--sk-border-subtle);
      border-radius: var(--sk-btn-radius);
      background: var(--sk-surface-3);
      color: var(--sk-text-muted);
      cursor: pointer;
      font-size: var(--sk-btn-font);
      line-height: 1.1;
      white-space: nowrap;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
    }
    .sk-btn:hover { background: var(--sk-surface-4); color: var(--sk-text); border-color: var(--sk-border-active); }
    .sk-btn--primary { background: var(--sk-accent-primary); color: var(--on-primary); border-color: var(--sk-accent-primary); }
    .sk-btn--primary:hover { background: var(--sk-accent-primary-container); }
    .sk-btn--danger { border-color: var(--sk-accent-danger); color: var(--sk-accent-danger); }
    .sk-btn--danger:hover { background: rgba(255, 107, 107, 0.1); }
    .sk-btn--sm { min-height: var(--sk-btn-height-sm); padding: var(--sk-btn-pad-y-sm) var(--sk-btn-pad-x-sm); font-size: var(--sk-btn-font-sm); }
    .sk-btn--link { min-height: 0; background: none; border: none; color: var(--sk-accent-primary); padding: 0; }
    .sk-btn--link:hover { color: var(--sk-text); background: none; border: none; }

    /* ── Forms ── */
    .sk-input, .sk-select, .sk-textarea {
      width: 100%;
      padding: 0.5rem 0.75rem;
      background: var(--sk-surface-0);
      border: 1px solid var(--sk-border-subtle);
      border-radius: var(--sk-radius-md);
      color: var(--sk-text);
      font-size: var(--sk-text-base);
      transition: border-color 0.15s;
    }
    .sk-input:focus, .sk-select:focus, .sk-textarea:focus {
      outline: none;
      border-color: var(--sk-accent-primary);
    }
    .sk-textarea { resize: vertical; min-height: 4rem; }
    .sk-label { display: block; font-size: var(--sk-text-sm); color: var(--sk-text-muted); margin-bottom: var(--sk-space-1); }
    .sk-form-group { margin-bottom: var(--sk-space-4); }
    .sk-form-row { display: flex; gap: var(--sk-space-3); align-items: flex-end; }

    /* ── Checkbox toggle ── */
    .sk-checkbox {
      display: flex;
      align-items: center;
      gap: var(--sk-space-3);
      cursor: pointer;
      padding: var(--sk-space-2) 0;
      margin-top: var(--sk-space-2);
    }
    .sk-checkbox input[type="checkbox"] {
      position: absolute;
      opacity: 0;
      width: 0;
      height: 0;
    }
    .sk-checkbox__toggle {
      position: relative;
      width: 36px;
      height: 20px;
      background: var(--sk-surface-4);
      border-radius: var(--sk-radius-lg);
      flex-shrink: 0;
      transition: background 0.2s;
    }
    .sk-checkbox__toggle::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 16px;
      height: 16px;
      background: var(--sk-text-muted);
      border-radius: 50%;
      transition: transform 0.2s, background 0.2s;
    }
    .sk-checkbox input:checked + .sk-checkbox__toggle {
      background: var(--sk-accent-primary);
    }
    .sk-checkbox input:checked + .sk-checkbox__toggle::after {
      transform: translateX(16px);
      background: #fff;
    }
    .sk-checkbox__label {
      font-size: var(--sk-text-sm);
      color: var(--sk-text-muted);
      user-select: none;
    }
    .sk-checkbox input:checked ~ .sk-checkbox__label {
      color: var(--sk-text);
    }

    /* ── Phase cards (team detail page) ── */
    .sk-phase-card {
      background: var(--sk-surface-2);
      border: 1px solid var(--sk-border);
      border-radius: var(--sk-radius-md);
      margin-bottom: var(--sk-space-4);
      overflow: hidden;
    }
    .sk-phase-card__header {
      display: flex;
      align-items: center;
      gap: var(--sk-space-3);
      padding: var(--sk-space-2) var(--sk-space-3);
      background: var(--sk-surface-3);
      border-bottom: 1px solid var(--sk-border);
    }
    .sk-phase-card__number {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: var(--sk-accent-secondary);
      color: #000;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
      flex-shrink: 0;
    }
    .sk-phase-card__title {
      font-weight: 600;
      font-size: var(--sk-text-sm);
      color: var(--sk-text);
    }
    .sk-phase-card__review-tag {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 2px 6px;
      border-radius: var(--sk-radius-xs);
      background: rgba(255,208,128,0.15);
      color: var(--sk-accent-warning);
      border: 1px solid rgba(255,208,128,0.3);
    }
    .sk-phase-card__body {
      padding: var(--sk-space-4);
    }

    /* ── Tables ── */
    .sk-table {
      width: 100%;
      border-collapse: collapse;
      font-size: var(--sk-text-sm);
    }
    .sk-table th {
      text-align: left;
      padding: var(--sk-space-2) var(--sk-space-3);
      color: var(--sk-text-muted);
      font-weight: 500;
      border-bottom: 1px solid var(--sk-border-subtle);
      font-size: var(--sk-text-xs);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .sk-table td {
      padding: var(--sk-space-2) var(--sk-space-3);
      border-bottom: 1px solid var(--sk-border);
    }
    .sk-table tr:hover td { background: rgba(255, 255, 255, 0.02); }

    /* ── Utility text ── */
    .sk-muted { color: var(--sk-text-muted); }
    .sk-mono { font-family: var(--sk-font-mono); font-size: var(--sk-text-sm); }
    .sk-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sk-eyebrow {
      font-size: var(--sk-text-xs);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--sk-text-muted);
      font-weight: 600;
      margin-top: var(--sk-space-2);
    }

    /* ── Inline edit forms (config page) ── */
    .sk-edit-row td {
      padding: 0 !important;
    }
    .sk-inline-edit-form {
      padding: var(--sk-space-4);
      background: var(--sk-surface-1);
      border-top: 1px solid var(--sk-border-subtle);
      display: flex;
      flex-direction: column;
      gap: var(--sk-space-3);
    }
    .sk-inline-edit-form__grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: var(--sk-space-3);
    }
    .sk-inline-edit-form__field {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .sk-inline-edit-form__label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--sk-text-subtle);
      font-weight: 600;
    }
    .sk-inline-edit-form__hint {
      font-size: var(--sk-text-xs);
      color: var(--sk-text-muted);
      line-height: 1.35;
    }
    .sk-inline-edit-form__section {
      display: flex;
      flex-direction: column;
      gap: var(--sk-space-2);
    }
    .sk-inline-edit-form__section-header {
      display: flex;
      align-items: center;
      gap: var(--sk-space-2);
      flex-wrap: wrap;
    }
    .sk-inline-edit-form__actions {
      display: flex;
      gap: var(--sk-space-2);
      padding-top: var(--sk-space-2);
      border-top: 1px solid var(--sk-border-subtle);
    }
    .sk-inline-edit-form__phases {
      display: flex;
      flex-direction: column;
      gap: var(--sk-space-2);
    }
    .sk-phase-edit {
      background: var(--sk-surface-2);
      border: 1px solid var(--sk-border-subtle);
      border-radius: var(--sk-radius-md);
      overflow: hidden;
    }
    .sk-phase-edit__header {
      display: flex;
      align-items: center;
      gap: var(--sk-space-2);
      padding: var(--sk-space-2) var(--sk-space-3);
      background: var(--sk-surface-2);
    }
    .sk-phase-edit__header-actions {
      display: flex;
      gap: 2px;
      margin-left: auto;
      flex-shrink: 0;
    }
    .sk-phase-edit__number {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: var(--sk-accent-primary-dim);
      color: var(--sk-accent-primary);
      font-size: 10px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .sk-phase-edit__body {
      padding: 0 var(--sk-space-3) var(--sk-space-3);
      display: flex;
      flex-direction: column;
      gap: var(--sk-space-2);
    }
    .sk-phase-edit__review-toggle {
      border: 1px solid var(--sk-border-subtle);
      border-radius: var(--sk-radius-md);
      padding: var(--sk-space-2) var(--sk-space-3);
      transition: border-color 0.15s, background 0.15s;
    }
    .sk-phase-edit__review-toggle--active {
      border-color: var(--sk-accent-primary);
      background: color-mix(in srgb, var(--sk-accent-primary) 6%, transparent);
    }
    .sk-phase-edit__review-label {
      display: flex;
      align-items: flex-start;
      gap: var(--sk-space-2);
      cursor: pointer;
      font-size: var(--sk-text-sm);
    }
    /* Reset the global \`form input\` rule (baseStyles.ts) which forces
       width:100%, display:block, padding, and border-bottom on every form
       input — including checkboxes. Without this the review checkbox
       stretches across the toggle box and pushes the label text into a
       narrow column on the right edge. */
    .sk-phase-edit input[type="checkbox"] {
      display: inline-block;
      width: auto;
      margin: 0;
      padding: 0;
      background: transparent;
      border: none;
      flex-shrink: 0;
    }
    .sk-phase-edit__review-label input[type="checkbox"] {
      margin-top: 2px;
    }
    .sk-phase-edit__consensus {
      font-size: var(--sk-text-xs);
      color: var(--sk-text-muted);
    }
    .sk-phase-edit__consensus summary {
      cursor: pointer;
      font-size: 11px;
      color: var(--sk-text-muted);
      padding: var(--sk-space-1) 0;
    }
    .sk-phase-edit__consensus-fields {
      display: flex;
      flex-wrap: wrap;
      gap: var(--sk-space-2);
      padding: var(--sk-space-2) 0;
      align-items: end;
    }
    .sk-table--compact {
      font-size: var(--sk-text-xs);
    }
    .sk-table--compact th,
    .sk-table--compact td {
      padding: var(--sk-space-1) var(--sk-space-2);
    }
  `;
}
