/**
 * TypeScript surface for `import { ... } from "@nexa/nui-host"`.
 */

export {
  NodeType,
  PropertyId,
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
  run,
} from "./ffi";

export type { NuiNode } from "./types";
export {
  normalizeTag,
  createHostElement,
  createHostText,
  createHostComment,
  createHostRoot,
  createHostInput,
} from "./node";

export {
  applyElementDefaults,
  applyNumericProp,
  applyHostProp,
  applyHostProps,
} from "./props";

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
  getWindowTitle,
  setWindowTitle,
  resetWindowTitle,
} from "./title";

export type { TextInputClient, TextRange, TextSelection, Rect } from "./text-input";
export type { Semantics } from "./semantics";
export { SemanticRole, SemanticAction } from "./semantics";
