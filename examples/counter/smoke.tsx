import { Column, Input, signal, Text, TextArea, Window } from "@nexa/ui";
import {
  addEventListenerV1,
  commit,
  commitV1,
  clearPropertyV1,
  createNodeV1,
  decodeHandleToken,
  encodeHandleToken,
  EventId,
  getCompositionBoundsV1,
  getTextInputStateV1,
  handshake,
  insert,
  NodeType,
  PropertyId,
  remove,
  removeEventListenerV1,
  replaceTextInputV1,
  resetSessionV1,
  setNumber,
} from "@nexa/nui-host";
import { Common } from "@nexa/protocol";
import { handleRefFromLegacyPacked } from "../../packages/nui-host/src/handle";
import { mountNode } from "../../packages/ui/src/mount/materialize";

const emptyFeatures = {
  required: { low: 0, high: 0 },
  optional: { low: 0, high: 0 },
};

const handshakeResult = handshake({
  protocol: Common.protocolVersion,
  abi: Common.abiVersion,
  clientRuntimeVersion: "counter-smoke",
  clientTargetTriple: "smoke-target",
  transport: { ...emptyFeatures, optional: { low: 1, high: 0 } },
  ui: { ...emptyFeatures, optional: { low: 20, high: 0 } },
  system: { ...emptyFeatures, optional: { low: 4, high: 0 } },
});

if (
  !handshakeResult.ok ||
  handshakeResult.value.transport.low !== 1 ||
  (handshakeResult.value.ui.low & 16) === 0
) {
  throw new Error("Perry handshake smoke failed");
}

const v1NodeResult = createNodeV1(NodeType.View);
if (!v1NodeResult.ok || encodeHandleToken(v1NodeResult.value) !== "h1/00000000/00000001") {
  throw new Error("Perry HandleRef create smoke failed");
}
const v1ClearResult = clearPropertyV1(v1NodeResult.value, PropertyId.Padding);
if (!v1ClearResult.ok) {
  throw new Error("Perry HandleRef clear-property smoke failed");
}
const firstListener = addEventListenerV1(v1NodeResult.value, EventId.Click, () => {});
if (!firstListener.ok) {
  throw new Error("Perry listener add smoke failed");
}
const replacementListener = addEventListenerV1(v1NodeResult.value, EventId.Click, () => {});
if (!replacementListener.ok) {
  throw new Error("Perry listener replacement smoke failed");
}
if (!removeEventListenerV1(firstListener.value).ok) {
  throw new Error("Perry stale listener remove smoke failed");
}
if (!removeEventListenerV1(replacementListener.value).ok) {
  throw new Error("Perry listener remove smoke failed");
}
if (!removeEventListenerV1(replacementListener.value).ok) {
  throw new Error("Perry listener idempotency smoke failed");
}
const invalidNodeResult = createNodeV1(99 as NodeType);
if (invalidNodeResult.ok || invalidNodeResult.error.code !== 0x0100_0001) {
  throw new Error("Perry invalid node argument was not structured");
}
const rejectedCommit = commitV1();
if (
  rejectedCommit.ok ||
  rejectedCommit.error.code !== 0x0100_0001 ||
  rejectedCommit.error.operation !== "commit"
) {
  throw new Error("Perry invalid batch was not rejected atomically");
}
const firstReset = resetSessionV1();
if (!firstReset.ok) {
  throw new Error("Perry reset-session smoke failed");
}
const oldNodeAfterReset = clearPropertyV1(v1NodeResult.value, PropertyId.Padding);
if (oldNodeAfterReset.ok || oldNodeAfterReset.error.name !== "STALE_HANDLE") {
  throw new Error("Perry reset did not invalidate the old Node handle");
}
if (!resetSessionV1().ok) {
  throw new Error("Perry idempotent reset-session smoke failed");
}
const postResetNode = createNodeV1(NodeType.View);
if (
  !postResetNode.ok ||
  encodeHandleToken(postResetNode.value) === encodeHandleToken(v1NodeResult.value)
) {
  throw new Error("Perry reset reused an exposed Node generation");
}
const postResetCommit = commitV1();
if (!postResetCommit.ok || postResetCommit.value.sequence !== 1) {
  throw new Error("Perry reset did not restart commit sequence at one");
}
const nonInputState = getTextInputStateV1(postResetNode.value);
if (nonInputState.ok || nonInputState.error.name !== "INVALID_ARGUMENT") {
  throw new Error("Perry TextInputClient state ABI did not return a structured error");
}
const nonInputReplace = replaceTextInputV1(postResetNode.value, { start: 0, end: 0 }, "中");
if (nonInputReplace.ok || nonInputReplace.error.name !== "INVALID_ARGUMENT") {
  throw new Error("Perry TextInputClient replace ABI did not return a structured error");
}
const nonInputBounds = getCompositionBoundsV1(postResetNode.value);
if (nonInputBounds.ok || nonInputBounds.error.name !== "INVALID_ARGUMENT") {
  throw new Error("Perry TextInputClient bounds ABI did not return a structured error");
}
if (!resetSessionV1().ok) {
  throw new Error("Perry post-reset cleanup smoke failed");
}

const textInputFixtureRoot = mountNode(<Column width={640} height={480} />);
const inputFixture = mountNode(<Input value="A😀B" placeholder="Title" />);
const textAreaFixture = mountNode(
  <TextArea value={"第一行\nA😀B"} placeholder="Body" width={320} height={160} />,
);
if (textInputFixtureRoot === null || inputFixture === null || textAreaFixture === null) {
  throw new Error("Perry TextInputClient fixture mount failed");
}
insert(inputFixture, textInputFixtureRoot);
insert(textAreaFixture, textInputFixtureRoot);
const textInputFixtureCommit = commitV1();
if (!textInputFixtureCommit.ok || textInputFixtureCommit.value.dirtyFlags === 0) {
  throw new Error("Perry TextInputClient fixture commit failed");
}
const inputReplace = replaceTextInputV1(
  handleRefFromLegacyPacked(inputFixture),
  { start: 1, end: 3 },
  "中",
);
if (!inputReplace.ok) {
  throw new Error("Perry Input replace success path failed");
}
const textAreaReplace = replaceTextInputV1(
  handleRefFromLegacyPacked(textAreaFixture),
  { start: 5, end: 7 },
  "中",
);
if (!textAreaReplace.ok) {
  throw new Error("Perry TextArea replace success path failed");
}
remove(textInputFixtureRoot);
const textInputFixtureCleanup = commitV1();
if (!textInputFixtureCleanup.ok || textInputFixtureCleanup.value.dirtyFlags === 0) {
  throw new Error("Perry TextInputClient fixture cleanup failed");
}

const maxHandle = decodeHandleToken("h1/ffffffff/ffffffff");
if (encodeHandleToken(maxHandle) !== "h1/ffffffff/ffffffff") {
  throw new Error("Perry HandleRef maximum round-trip failed");
}

for (const token of ["h1/0/00000001", "h1/00000000/00000000", "h1/00000000/FFFFFFFF"]) {
  let rejected = false;
  try {
    decodeHandleToken(token);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`Invalid HandleRef token accepted: ${token}`);
}

for (const handle of [
  { slot: -1, generation: 1 },
  { slot: 0, generation: 0 },
  { slot: 0x1_0000_0000, generation: 1 },
  { slot: 0, generation: 1.5 },
  { slot: 0, generation: Number.NaN },
  { slot: 0, generation: Number.POSITIVE_INFINITY },
  { slot: 0, generation: 1, extra: true },
] as unknown[]) {
  let rejected = false;
  try {
    encodeHandleToken(handle as Common.HandleRef);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("Invalid HandleRef shape accepted");
}

console.log(`node type ${String(NodeType.View)} ${typeof NodeType.View}`);

const count = signal(0);
const root = mountNode(
  <Window title="Nexa UI smoke">
    <Column>
      <Text>Count: {count}</Text>
    </Column>
  </Window>,
);

if (root === null) {
  throw new Error("Minimal TSX smoke produced no root node");
}

setNumber(root, PropertyId.Padding, 24);

const firstCommit = commitV1();
if (!firstCommit.ok || firstCommit.value.sequence === 0 || firstCommit.value.dirtyFlags === 0) {
  throw new Error("Perry first commit receipt smoke failed");
}
// Exercise the legacy ABI as an idempotent empty commit.
commit();
count.value = 1;
const secondCommit = commitV1();
if (
  !secondCommit.ok ||
  secondCommit.value.sequence !== firstCommit.value.sequence + 1 ||
  secondCommit.value.dirtyFlags === 0
) {
  throw new Error("Perry reactive commit receipt smoke failed");
}
remove(root);
const thirdCommit = commitV1();
if (
  !thirdCommit.ok ||
  thirdCommit.value.sequence !== secondCommit.value.sequence + 1 ||
  thirdCommit.value.dirtyFlags === 0
) {
  throw new Error("Perry remove commit receipt smoke failed");
}

console.log("nexa-ui perry smoke ok");
