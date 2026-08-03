/**
 * Visual-tree semantics for assistive tech (ADR-006 §3.3).
 * First-class on the Host protocol; AccessKit export is a later slice.
 */

export enum SemanticRole {
  None = 0,
  Button = 1,
  Text = 2,
  Image = 3,
  TextInput = 4,
  Scroll = 5,
  Header = 6,
}

export enum SemanticAction {
  Invoke = 1,
  Focus = 2,
  SetValue = 3,
}

export type Semantics = {
  role?: SemanticRole;
  label?: string;
  value?: string;
  description?: string;
  disabled?: boolean;
  checked?: boolean;
  actions?: SemanticAction[];
};
