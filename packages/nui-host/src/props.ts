import { EventId, PropertyId, registerInput, setImage, setNumber, setText } from "./ffi";
import type { NuiNode } from "./types";
import { handleRefFromLegacyPacked } from "./handle";
import {
  addEventListenerV1,
  clearPropertyV1,
  clearSemanticsV1,
  removeEventListenerV1,
  setSemanticsV1,
} from "./protocol";
import type { Common, Ui } from "@nexa/protocol";
import { diffPropRecord, type HostPropRecord } from "./props-state";
import { resetWindowTitle, setWindowTitle } from "./title";
import { NexaHostError } from "./errors";

export { applyElementDefaults } from "./defaults";

function propertyForName(name: string): PropertyId | null {
  switch (name) {
    case "width":
      return PropertyId.Width;
    case "height":
      return PropertyId.Height;
    case "minWidth":
      return PropertyId.MinWidth;
    case "minHeight":
      return PropertyId.MinHeight;
    case "padding":
      return PropertyId.Padding;
    case "gap":
      return PropertyId.Gap;
    case "flexDirection":
      return PropertyId.FlexDirection;
    case "fontSize":
      return PropertyId.FontSize;
    case "fontWeight":
      return PropertyId.FontWeight;
    case "opacity":
      return PropertyId.Opacity;
    case "borderRadius":
      return PropertyId.BorderRadius;
    case "color":
      return PropertyId.TextColor;
    case "backgroundColor":
      return PropertyId.BackgroundColor;
    case "flexGrow":
      return PropertyId.FlexGrow;
    case "disabled":
      return PropertyId.Disabled;
    case "scrollOffsetY":
      return PropertyId.ScrollOffsetY;
    case "alignItems":
      return PropertyId.AlignItems;
    case "justifyContent":
      return PropertyId.JustifyContent;
    default:
      return null;
  }
}

export function applyNumericProp(node: NuiNode, name: string, value: unknown): boolean {
  if (name === "disabled" || typeof value !== "number") return false;
  const property = propertyForName(name);
  if (property === null) return false;
  setNumber(node.id, property, value);
  return true;
}

export function clearNumericProp(node: NuiNode, name: string): void {
  const property = propertyForName(name);
  if (property !== null) {
    const result = clearPropertyV1(handleRefFromLegacyPacked(node.id), property);
    if (!result.ok) {
      throw new NexaHostError(result.error);
    }
  }
}

function asPropRecord(value: unknown): HostPropRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as HostPropRecord)
    : {};
}

function inputTextChild(node: NuiNode): NuiNode | null {
  return node.children.find((c) => c.isText) ?? null;
}

function isEditableTextNode(node: NuiNode): boolean {
  return node.tag === "input" || node.tag === "textarea";
}

function eventForName(name: string): EventId | null {
  switch (name.toLowerCase()) {
    case "onclick":
      return EventId.Click;
    case "onchange":
    case "oninput":
      return EventId.Change;
    case "onsubmit":
      return EventId.Submit;
    case "oncomposition":
      return EventId.Composition;
    case "onlifecycle":
      return EventId.WindowLifecycle;
    default:
      return null;
  }
}

function decodeWindowLifecyclePayload(payload: string): Ui.WindowLifecycleEvent {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch (error) {
    throw new TypeError(`window lifecycle payload is not valid JSON: ${String(error)}`);
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("window lifecycle payload must be an object");
  }

  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "kind" && key !== "surfaceGeneration")) {
    throw new TypeError("window lifecycle payload contains an unknown field");
  }

  if (
    record.kind !== "Ready" &&
    record.kind !== "Suspended" &&
    record.kind !== "Resumed" &&
    record.kind !== "CloseRequested"
  ) {
    throw new TypeError("window lifecycle payload kind is invalid");
  }

  const surfaceGeneration = record.surfaceGeneration;
  const hasSurfaceGeneration = surfaceGeneration !== undefined;
  if (
    hasSurfaceGeneration &&
    (typeof surfaceGeneration !== "number" ||
      !Number.isInteger(surfaceGeneration) ||
      surfaceGeneration < 1 ||
      surfaceGeneration > 9_007_199_254_740_991)
  ) {
    throw new TypeError(
      "window lifecycle payload surfaceGeneration must be a positive safe integer",
    );
  }

  return {
    kind: record.kind as Ui.WindowLifecycleKind,
    ...(hasSurfaceGeneration ? { surfaceGeneration } : {}),
  };
}

function removeListener(node: NuiNode, event: EventId): void {
  const handle = node.hostListeners[event];
  if (handle === undefined) return;
  const result = removeEventListenerV1(handle);
  if (!result.ok) {
    throw new NexaHostError(result.error);
  }
  delete node.hostListeners[event];
}

function setListener(node: NuiNode, event: EventId, callback: unknown): void {
  removeListener(node, event);
  let listener = callback;
  if (event === EventId.Composition) {
    listener = (payload: string) => {
      let value: unknown;
      try {
        value = JSON.parse(payload);
      } catch (error) {
        throw new TypeError(`composition payload is not valid JSON: ${String(error)}`);
      }
      (callback as (event: Ui.CompositionEvent) => void)(value as Ui.CompositionEvent);
    };
  } else if (event === EventId.WindowLifecycle) {
    listener = (payload: string) => {
      (callback as (event: Ui.WindowLifecycleEvent) => void)(decodeWindowLifecyclePayload(payload));
    };
  }
  const result = addEventListenerV1(nodeIdToHandle(node.id), event, listener);
  if (!result.ok) {
    throw new NexaHostError(result.error);
  }
  node.hostListeners[event] = result.value;
}

function nodeIdToHandle(id: bigint): Common.HandleRef {
  return handleRefFromLegacyPacked(id);
}

/**
 * Apply a single framework prop onto a Host mirror node.
 * Handles title / style / click / input / numeric / text content.
 */
export function applyHostProp(node: NuiNode, name: string, value: unknown): void {
  if (name === "children" || name === "ref") {
    return;
  }

  const previous = node.hostProps[name];

  if (name === "style") {
    const nextStyle = asPropRecord(value);
    for (const [styleName, styleValue] of diffPropRecord(asPropRecord(previous), nextStyle)) {
      if (styleValue == null) clearNumericProp(node, styleName);
      else applyNumericProp(node, styleName, styleValue);
    }
    if (value == null) delete node.hostProps[name];
    else node.hostProps[name] = { ...nextStyle };
    return;
  }

  if (name === "semantics") {
    const result =
      value == null
        ? clearSemanticsV1(nodeIdToHandle(node.id))
        : setSemanticsV1(nodeIdToHandle(node.id), value as Ui.Semantics);
    if (!result.ok) {
      throw new NexaHostError(result.error);
    }
    if (value == null) {
      delete node.hostProps[name];
    } else {
      const semantics = value as Ui.Semantics;
      node.hostProps[name] = {
        ...semantics,
        ...(semantics.actions === undefined ? {} : { actions: [...semantics.actions] }),
      };
    }
    return;
  }

  if (name === "title" && typeof value === "string") {
    setWindowTitle(value);
    node.hostProps[name] = value;
    return;
  }

  if (name === "title" && value == null) {
    resetWindowTitle();
    delete node.hostProps[name];
    return;
  }

  const event = eventForName(name);
  if (event !== null) {
    if (typeof value === "function") {
      setListener(node, event, value);
      node.hostProps[name] = value;
    } else {
      removeListener(node, event);
      delete node.hostProps[name];
    }
    return;
  }

  if (name === "disabled" && typeof value === "boolean") {
    setNumber(node.id, PropertyId.Disabled, value ? 1 : 0);
    node.hostProps[name] = value;
    return;
  }

  if (value == null && node.isText && (name === "textContent" || name === "text")) {
    node.text = "";
    setText(node.id, "");
    delete node.hostProps[name];
    return;
  }

  if (node.tag === "image" && name === "src" && value == null) {
    setImage(node.id, "");
    delete node.hostProps[name];
    return;
  }

  if (isEditableTextNode(node) && value == null) {
    const text = inputTextChild(node);
    if (name === "placeholder") {
      if (text) registerInput(node.id, text.id, "");
      delete node.hostProps[name];
      return;
    }
    if (name === "value") {
      if (text) {
        text.text = "";
        setText(text.id, "");
      }
      delete node.hostProps[name];
      return;
    }
  }

  if (value == null) {
    clearNumericProp(node, name);
    delete node.hostProps[name];
    return;
  }

  if (node.tag === "image") {
    if (name === "src" && typeof value === "string") {
      setImage(node.id, value);
      node.hostProps[name] = value;
      return;
    }
  }

  if (isEditableTextNode(node)) {
    if (name === "placeholder" && typeof value === "string") {
      const text = inputTextChild(node);
      if (text) {
        registerInput(node.id, text.id, value);
      }
      node.hostProps[name] = value;
      return;
    }
    if (name === "value" && (typeof value === "string" || typeof value === "number")) {
      const text = inputTextChild(node);
      if (text) {
        text.text = String(value);
        setText(text.id, text.text);
      }
      node.hostProps[name] = value;
      return;
    }
  }

  const applied = applyNumericProp(node, name, value);

  if (node.isText && (name === "textContent" || name === "text")) {
    node.text = String(value ?? "");
    setText(node.id, node.text);
  }
  if (applied || (node.isText && (name === "textContent" || name === "text"))) {
    node.hostProps[name] = value;
  }
}

export function applyHostProps(node: NuiNode, props: Record<string, unknown>): void {
  for (const [key, value] of diffPropRecord(node.hostProps, props)) {
    applyHostProp(node, key, value);
  }
}
