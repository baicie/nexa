/**
 * TypeScript surface for `import { ... } from "@nexa/nui-host"`.
 */

// Perry collects nativeLibrary archives from imports. The UI runtime invokes
// the System Host completion hook, so both static archives must link together.
import "@nexa/system-host";

export {
  NodeType,
  PropertyId,
  EventId,
  rgba,
  createNode,
  createText,
  insert,
  remove,
  setText,
  setNumber,
  addClickListener,
  registerInput,
  addChangeListener,
  addSubmitListener,
  setImage,
  commit,
} from "./ffi";
export { run } from "./session";
export { NexaHostError, clearErrorHistory, getErrorHistory, setErrorHandler } from "./errors";

export {
  addEventListenerV1,
  clearPropertyV1,
  clearSemanticsV1,
  commitV1,
  createNodeV1,
  getCompositionBoundsV1,
  getTextInputStateV1,
  handshake,
  removeEventListenerV1,
  registerButtonV1,
  replaceTextInputV1,
  resetSessionV1,
  runV1,
  setSemanticsV1,
} from "./protocol";
export { decodeHandleToken, encodeHandleToken } from "./handle";

export type { NuiNode } from "./types";
export {
  normalizeTag,
  createAdapterHostElement,
  createHostElement,
  createHostText,
  createHostComment,
  createHostRoot,
  createHostInput,
  createHostTextArea,
} from "./node";

export { applyElementDefaults, applyNumericProp, applyHostProp, applyHostProps } from "./props";

export {
  unlink,
  insertBefore,
  removeNode,
  clearChildren,
  getParent,
  getFirstChild,
  getNextSibling,
} from "./tree";
export {
  activeNodeCount,
  attachNode,
  disposeNode,
  registerNodeCleanup,
  resetNodeLifecycle,
} from "./lifecycle";
export { resetSession } from "./session";

export { getWindowTitle, setWindowTitle, resetWindowTitle } from "./title";

export { createTextInputClient } from "./text-input";
export type { TextInputClient, TextRange, TextSelection, Rect } from "./text-input";
export type { Semantics } from "./semantics";
export { SemanticRole, SemanticAction } from "./semantics";
