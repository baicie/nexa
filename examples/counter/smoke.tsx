import { Column, signal, Text, Window } from "@nexa/ui";
import { commit, handshake, NodeType, remove } from "@nexa/nui-host";
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
