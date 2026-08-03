/**
 * React reconciler → NUI Host (Slice 7 / ADR-004 M5).
 *
 * Locked: react@18.3 + react-reconciler@0.29 (mutation mode).
 */

import React from "react";

export type { NuiNode } from "./host-config";
export { render } from "./render";

export { React };
export default React;
export {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  useContext,
  createContext,
  createElement,
  Fragment,
  Component,
} from "react";
