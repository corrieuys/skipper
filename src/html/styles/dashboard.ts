/** Command center (dashboard) layout styles */
export function dashboardStyles(): string {
  return `
    .sk-dashboard {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 320px;
      gap: var(--sk-space-4);
      height: calc(100vh - 48px);
      padding: var(--sk-space-4);
      overflow: hidden;
    }
    .sk-dashboard--idle .sk-dashboard__main {
      max-width: 640px;
    }
    .sk-dashboard__main {
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: var(--sk-space-4);
    }
    .sk-dashboard__chat {
      overflow-y: hidden;
      display: flex;
      flex-direction: column;
    }

    /* ── Metrics bar ── */
    .sk-metrics {
      display: flex;
      gap: var(--sk-space-4);
      padding: var(--sk-space-3) 0;
    }
    .sk-metric {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.15rem;
    }
    .sk-metric__value {
      font-family: var(--sk-font-heading);
      font-size: var(--sk-text-xl);
      font-weight: 700;
      line-height: 1;
    }
    .sk-metric__value--primary { color: var(--sk-accent-primary); }
    .sk-metric__value--secondary { color: var(--sk-accent-secondary); }
    .sk-metric__value--tertiary { color: var(--sk-accent-tertiary); }
    .sk-metric__value--danger { color: var(--sk-accent-danger); }
    .sk-metric__value--muted { color: var(--sk-text-muted); }
    .sk-metric__label {
      font-size: var(--sk-text-xs);
      color: var(--sk-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    /* ── Escalation bar ── */
    .sk-escalation-bar {
      display: flex;
      align-items: center;
      gap: var(--sk-space-3);
      padding: var(--sk-space-2) var(--sk-space-4);
      background: rgba(255, 107, 107, 0.12);
      border: 1px solid rgba(255, 107, 107, 0.3);
      color: var(--sk-accent-danger);
      font-size: var(--sk-text-sm);
      font-weight: 500;
    }
    .sk-escalation-bar__icon {
      font-weight: 700;
      font-size: var(--sk-text-lg);
    }
    .sk-escalation-bar__text { flex: 1; }
    .sk-escalation-bar__action {
      color: var(--sk-accent-danger);
      font-weight: 600;
      text-decoration: underline;
    }

    /* ── Active mission card ── */
    .sk-mission {
      background: var(--sk-surface-2);
      border: 1px solid var(--sk-border-active);
      padding: var(--sk-space-4);
    }
    .sk-mission__title {
      font-size: var(--sk-text-lg);
      font-weight: 600;
      color: var(--sk-text);
      margin-bottom: var(--sk-space-2);
    }
    .sk-mission__meta {
      display: flex;
      align-items: center;
      gap: var(--sk-space-3);
      font-size: var(--sk-text-sm);
      color: var(--sk-text-muted);
      margin-bottom: var(--sk-space-3);
    }
    .sk-mission__phases {
      display: flex;
      gap: var(--sk-space-1);
      margin-bottom: var(--sk-space-3);
    }
    .sk-mission__actions {
      display: flex;
      justify-content: flex-end;
    }

    /* ── Task create card (idle state) ── */
    .sk-create-card {
      background: var(--sk-surface-2);
      border: 1px dashed var(--sk-border-subtle);
      padding: var(--sk-space-6);
    }
    .sk-create-card__title {
      font-size: var(--sk-text-lg);
      font-weight: 600;
      color: var(--sk-text);
      margin-bottom: var(--sk-space-4);
    }
  `;
}
