/** Shared window title used by adapters before `run()`. */

let windowTitle = "Nexa UI";

export function getWindowTitle(): string {
  return windowTitle;
}

export function setWindowTitle(title: string): void {
  windowTitle = title;
}

export function resetWindowTitle(fallback = "Nexa UI"): void {
  windowTitle = fallback;
}
