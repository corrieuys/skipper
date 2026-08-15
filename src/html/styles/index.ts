/**
 * Aggregates all style modules into a single CSS string.
 * Order matters: tokens first, then reset, then component styles.
 */
import { tokens } from "./tokens";
import { reset } from "./reset";
import { layoutStyles } from "./layout";
import { componentStyles } from "./components";
import { panelStyles } from "./panels";
import { treeStyles } from "./tree";
import { terminalStyles } from "./terminal";
import { dashboardStyles } from "./dashboard";
import { utilityStyles } from "./utilities";
import { animationStyles } from "./animations";
import { missionControlStyles } from "./mission-control";
import { teamCenterStyles } from "./team-center";
import { teamMapStyles } from "./team-map";
import { toastStyles } from "./toast";

/** New design system styles (sk- prefixed). Used by v2 pages. */
export function skStyles(): string {
  return [
    tokens(),
    reset(),
    layoutStyles(),
    componentStyles(),
    panelStyles(),
    treeStyles(),
    terminalStyles(),
    dashboardStyles(),
    utilityStyles(),
    animationStyles(),
    missionControlStyles(),
    teamCenterStyles(),
    teamMapStyles(),
    toastStyles(),
  ].join("\n");
}

export { themesCss, themeOverridesCss, glassOverridesCss, appearanceBackgroundCss } from "./themes";
