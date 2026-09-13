import type { Store } from "../model/store";
import { topModal, type UIState } from "./state";

/**
 * Footer key hints for the current context. Pure: the renderer calls this
 * every frame. Task-action hints come from the action registry in the
 * controller; to keep the renderer free of controller imports the controller
 * publishes them through `setActionHints`.
 */
let actionHints: (store: Store, ui: UIState) => Array<[string, string]> = () => [];

export function setActionHints(fn: (store: Store, ui: UIState) => Array<[string, string]>): void {
  actionHints = fn;
}

export function footerHints(store: Store, ui: UIState): Array<[string, string]> {
  const m = topModal(ui);
  if (m) {
    switch (m.kind) {
      case "form":
        return [["tab", "next field"], ["ctrl+s", "submit"], ["esc", "cancel"]];
      case "confirm":
        return [["enter", m.confirmLabel.toLowerCase()], ["esc", "cancel"]];
      case "list":
        return m.filterable && m.filterFocused !== false
          ? [["type", "to filter"], ["↓", "to the list"], ["enter", "pick"], ["esc", "close"]]
          : [["↑↓ jk", "move"], ["enter", "pick"], ["/", "filter"], ["esc", "close"]];
      case "text":
        return [["↑↓", "scroll"], ["esc", "close"]];
    }
  }
  if (ui.composerActive) return [["enter", "send"], ["ctrl+j", "newline"], ["esc", "cancel"]];
  if (ui.searchActive) return [["type", "to filter"], ["enter", "done"], ["esc", "clear"]];
  const base: Array<[string, string]> = [];
  if (ui.focus === "rail" || ui.filter === "recurring") base.push(["↑↓", "select"]);
  else if (ui.detailTab === "artifacts") base.push(["↑↓", "select"], ["enter", "open artifact"]);
  else base.push(["↑↓", "scroll"]);
  base.push(...actionHints(store, ui));
  base.push([":", "commands"], ["?", "help"]);
  return base;
}
