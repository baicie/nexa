import { Column, signal, Text, Window } from "@nexa/ui";
import {
  commit,
  createNodeV1,
  decodeHandleToken,
  encodeHandleToken,
  handshake,
  NodeType,
  remove,
} from "@nexa/nui-host";
import { Common } from "@nexa/protocol";
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
  ui: { ...emptyFeatures, optional: { low: 4, high: 0 } },
  system: { ...emptyFeatures, optional: { low: 4, high: 0 } },
});

if (!handshakeResult.ok || handshakeResult.value.transport.low !== 1) {
  throw new Error("Perry handshake smoke failed");
}

const v1NodeResult = createNodeV1(NodeType.View);
if (!v1NodeResult.ok || encodeHandleToken(v1NodeResult.value) !== "h1/00000000/00000001") {
  throw new Error("Perry HandleRef create smoke failed");
}
const invalidNodeResult = createNodeV1(99 as NodeType);
if (invalidNodeResult.ok || invalidNodeResult.error.code !== 0x0100_0001) {
  throw new Error("Perry invalid node argument was not structured");
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

commit();
count.value = 1;
commit();
remove(root);
commit();

console.log("nexa-ui perry smoke ok");
