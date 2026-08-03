/** In-memory mirror of a Host node used by framework adapters. */
export type NuiNode = {
  id: bigint;
  tag: string;
  isText: boolean;
  /** Vue Fragment / v-if anchors; ignored by other adapters. */
  isComment?: boolean;
  parent: NuiNode | null;
  children: NuiNode[];
  text: string;
};
