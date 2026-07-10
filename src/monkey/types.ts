// `text` is optional on every move so greg can travel AND talk in one breath
// (e.g. jump to a field while roasting it). On "say" the text is the point.
export type MonkeyAction =
  | { type: "walk"; direction: "left" | "right"; steps: number; text?: string }
  | { type: "jump"; target: string; text?: string }
  | { type: "slide"; text?: string }
  | { type: "idle"; text?: string }
  | { type: "say"; text: string };

export interface MonkeyState {
  x: number;
  y: number;
  surface: string | null;
  animation: "idle" | "walking" | "jumping" | "talking" | "sliding";
  facing: "left" | "right";
}

export interface DOMSection {
  id: string;
  label: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  content: string;
  children: DOMElement[];
}

export interface DOMElement {
  id: string;
  tag: string;
  type: string;
  label: string;
  x: number;
  y: number;
}

export interface Perch {
  id: string;
  label: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UserEvent {
  kind: "click" | "type" | "navigate" | "scroll";
  target: string;
  value?: string;
  timestamp: number;
}

export interface TaskDetail {
  title: string;
  status: string;
  phase: number;
  agentCount: number;
  delegationCount: number;
  recentOutput: string;
  notes: Array<{ agent: string; content: string }>;
  artifacts: Array<{ name: string; kind: string }>;
}

export interface ScheduledTaskInfo {
  title: string;
  status: string;
  scheduleAmount: number | null;
  scheduleUnit: string | null;
  /** True when the task uses a weekly schedule matrix instead of an interval. */
  hasWeeklySchedule: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export interface RecentTaskInfo {
  title: string;
  status: string;
  updatedAt: string;
}

export interface NewNote {
  id: string;
  agent: string;
  content: string;
  taskTitle: string;
  createdAt: string;
}

export interface DashboardContext {
  activeTask: TaskDetail | null;
  activeTasks: TaskDetail[];
  recentTasks: RecentTaskInfo[];
  scheduledTasks: ScheduledTaskInfo[];
  newNotes: NewNote[];
  totalAgentsRunning: number;
  openEscalations: number;
}

export interface MonkeyCommand {
  action: MonkeyAction;
  perches: Perch[];
}
