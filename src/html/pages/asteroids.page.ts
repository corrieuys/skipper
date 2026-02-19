import { v2layout } from "../shell/layout";
import { navbar } from "../shell/navbar";

export interface AsteroidsPageViewModel {
  daemonState: string;
  daemonUptime: number;
  escalationCount: number;
}

export function asteroidsPage(vm: AsteroidsPageViewModel): string {
  return v2layout("Asteroids", `
    ${navbar({ currentPath: "/games/asteroids", daemonState: vm.daemonState, daemonUptime: vm.daemonUptime, escalationCount: vm.escalationCount })}
    <div id="asteroids-root" style="position:fixed;inset:0;top:48px;z-index:1;pointer-events:auto;">
      <canvas id="game-canvas" style="display:block;"></canvas>
    </div>
    <script src="/asteroids.js"></script>
  `, "/games/asteroids");
}
