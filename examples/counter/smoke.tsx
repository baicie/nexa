import { Column, signal, Text, Window } from "@nexa/ui";
import { commit, remove } from "@nexa/nui-host";
import { mountNode } from "../../packages/ui/src/mount/materialize";

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
