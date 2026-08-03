/**
 * @nexa/ui — Minimal TSX surface (Slice 3).
 *
 * Acceptance target from ADR-004:
 *   Window / Column / Row / View / Text / Button / signal / onClick
 *
 * Implementations land after Slice 2 (Perry Host FFI) is green.
 */

export { signal } from "./signal";
export type { Signal } from "./signal";
export type { HostOps, NodeId } from "./host";
export { NodeType, PropertyId, EventType } from "./host";

/** Placeholder mount — wired in Slice 3. */
export function mount(_root: unknown): void {
  throw new Error("@nexa/ui mount() is not implemented yet (Slice 3)");
}
