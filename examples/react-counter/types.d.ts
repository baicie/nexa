import "react";

declare global {
  const console: {
    log(...values: unknown[]): void;
  };
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      window: Record<string, unknown>;
      column: Record<string, unknown>;
      text: Record<string, unknown>;
      button: Record<string, unknown>;
    }
  }
}
