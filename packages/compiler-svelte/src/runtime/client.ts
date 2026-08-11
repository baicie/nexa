import {
  applyHostProp,
  createAdapterHostElement,
  createHostComment,
  createHostText,
  insertBefore,
  registerNodeCleanup,
  removeNode,
  setText,
  type NuiNode,
} from "@nexa/nui-host";

type Source<T> = {
  value: T;
  observers: Set<Observer>;
};

type Observer = {
  run: () => void;
  sources: Set<Source<unknown>>;
  stopped: boolean;
};

type ComponentOptions = {
  component: (anchor: NuiNode, props: Record<string, unknown>) => Record<string, unknown>;
  target?: NuiNode;
  props?: Record<string, unknown>;
};

type LegacyComponent = Record<string, unknown> & {
  $destroy?: () => void;
  $on?: (event: string, callback: (...args: unknown[]) => void) => () => void;
  $set?: (props: Record<string, unknown>) => void;
};

let currentObserver: Observer | null = null;
let currentComponent: ComponentRuntime | null = null;
const dynamicTextNodes = new WeakMap<NuiNode, { node: NuiNode; prefix: string }>();

type ComponentRuntime = {
  effects: Set<() => void>;
  destroyed: boolean;
};

function observe(run: () => void): () => void {
  const observer: Observer = {
    run: () => {
      if (observer.stopped) return;
      for (const source of observer.sources) source.observers.delete(observer);
      observer.sources.clear();
      const previous = currentObserver;
      currentObserver = observer;
      try {
        run();
      } finally {
        currentObserver = previous;
      }
    },
    sources: new Set(),
    stopped: false,
  };
  observer.run();
  const stop = () => {
    if (observer.stopped) return;
    observer.stopped = true;
    for (const source of observer.sources) source.observers.delete(observer);
    observer.sources.clear();
  };
  currentComponent?.effects.add(stop);
  return stop;
}

function source<T>(value: T): Source<T> {
  return { value, observers: new Set() };
}

export function mutable_source<T>(value: T): Source<T> {
  return source(value);
}

export function get<T>(signal: Source<T>): T {
  if (currentObserver !== null) {
    currentObserver.sources.add(signal as Source<unknown>);
    signal.observers.add(currentObserver);
  }
  return signal.value;
}

export function set<T>(signal: Source<T>, value: T): T {
  if (Object.is(signal.value, value)) return value;
  signal.value = value;
  const observers = new Set(signal.observers);
  for (const observer of observers) observer.run();
  return value;
}

export function push(_props: Record<string, unknown>, _runes = false): void {}

export function pop<T>(component?: T): T | Record<string, never> {
  return component ?? {};
}

export function template_effect(fn: () => void): void {
  observe(fn);
}

export function if_block(
  anchor: NuiNode,
  render: (branch: (create: (target: NuiNode) => void) => void) => void,
): void {
  let branch: NuiNode[] = [];
  observe(() => {
    for (const node of branch) removeNode(node);
    branch = [];
    const parent = anchor.parent ?? anchor;
    const before = new Set(parent.children);
    render((create) => create(parent));
    branch = parent.children.filter((node) => !before.has(node));
  });
}

export { if_block as if };

function parseAttributeValue(value: string | undefined): unknown {
  if (value === undefined) return true;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/u.test(value)) return Number(value);
  return value;
}

function fromTemplate(template: string): () => NuiNode {
  return () => {
    const roots: NuiNode[] = [];
    const stack: NuiNode[] = [];
    const tokens = template.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) ?? [];
    for (const token of tokens) {
      if (token.startsWith("<!--") || token === "<!>") {
        const node = createHostComment();
        const parent = stack.at(-1);
        if (parent) insertBefore(parent, node, null);
        else roots.push(node);
        continue;
      }
      if (token.startsWith("</")) {
        stack.pop();
        continue;
      }
      if (token.startsWith("<")) {
        const match = /^<([A-Za-z][\w:-]*)([^>]*)>$/u.exec(token);
        if (!match) continue;
        const tag = match[1] ?? "";
        const rawAttributes = match[2] ?? "";
        const node = createAdapterHostElement(tag);
        const attributes = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/gu;
        for (const attribute of rawAttributes.matchAll(attributes)) {
          const name = attribute[1];
          if (!name) continue;
          applyHostProp(
            node,
            name,
            parseAttributeValue(attribute[2] ?? attribute[3] ?? attribute[4]),
          );
        }
        const parent = stack.at(-1);
        if (parent) insertBefore(parent, node, null);
        else roots.push(node);
        if (!/\/\s*>$/u.test(token) && !/^(?:input|img|br|hr)$/iu.test(tag)) stack.push(node);
        continue;
      }
      if (token.length === 0) continue;
      const node = createHostText(token);
      const parent = stack.at(-1);
      if (parent) insertBefore(parent, node, null);
      else roots.push(node);
    }
    if (roots.length !== 1) throw new Error("Svelte runtime template must have one root node");
    return roots[0]!;
  };
}

export const from_html = fromTemplate;
export const from_svg = fromTemplate;

export function child(node: NuiNode): NuiNode | null {
  return node.children[0] ?? null;
}

export function sibling(node: NuiNode, count = 1): NuiNode | null {
  let current = node;
  for (let index = 0; index < count; index += 1) {
    const parent = current.parent;
    if (!parent) return null;
    const next = parent.children[parent.children.indexOf(current) + 1];
    if (!next) return null;
    current = next;
  }
  return current;
}

export function reset(_node: NuiNode): void {}

export function set_attribute(node: NuiNode, name: string, value: unknown): void {
  applyHostProp(node, name, value);
}

export function set_text(node: NuiNode, value: unknown): void {
  const text = String(value ?? "");
  const dynamicText = dynamicTextNodes.get(node);
  if (dynamicText) {
    if (!text.startsWith(dynamicText.prefix)) {
      dynamicTextNodes.delete(node);
      removeNode(dynamicText.node);
      node.text = text;
      setText(node.id, text);
      return;
    }
    const nextValue = text.slice(dynamicText.prefix.length);
    dynamicText.node.text = nextValue;
    setText(dynamicText.node.id, nextValue);
    return;
  }
  const separator = text.indexOf(": ");
  if (separator > 0 && node.parent?.tag === "text") {
    const prefix = text.slice(0, separator + 2);
    const dynamicValue = text.slice(prefix.length);
    node.text = prefix;
    setText(node.id, prefix);
    const siblingText = createHostText(dynamicValue);
    insertBefore(
      node.parent,
      siblingText,
      node.parent.children[node.parent.children.indexOf(node) + 1] ?? null,
    );
    dynamicTextNodes.set(node, { node: siblingText, prefix });
    return;
  }
  const childNode = node.children.find((candidate) => candidate.isText);
  if (childNode) {
    childNode.text = text;
    setText(childNode.id, text);
  } else if (node.isText) {
    node.text = text;
    setText(node.id, text);
  } else {
    insertBefore(node, createHostText(text), null);
  }
}

export function event(name: string, node: NuiNode, handler: (...args: unknown[]) => void): void {
  const normalized = name.length === 0 ? name : `${name[0]!.toUpperCase()}${name.slice(1)}`;
  const prop = `on${normalized}`;
  applyHostProp(node, prop, handler);
  registerNodeCleanup(node.id, () => applyHostProp(node, prop, null));
}

export function update_legacy_props(props: Record<string, unknown>): Record<string, unknown> {
  return props;
}

export function add_legacy_event_listener(
  _props: Record<string, unknown>,
  _event: string,
  _callback: (...args: unknown[]) => void,
): () => void {
  return () => {};
}

export function createClassComponent(options: ComponentOptions): LegacyComponent {
  if (!options.target) throw new Error("Svelte component target is required");
  const runtime: ComponentRuntime = { effects: new Set(), destroyed: false };
  const before = new Set(options.target.children);
  const previous = currentComponent;
  currentComponent = runtime;
  let exports: Record<string, unknown> = {};
  try {
    exports = options.component(options.target, options.props ?? {});
  } finally {
    currentComponent = previous;
  }
  const instance: LegacyComponent = { ...exports };
  instance.$destroy = () => {
    if (runtime.destroyed) return;
    runtime.destroyed = true;
    for (const stop of runtime.effects) stop();
    for (const node of options.target?.children.filter((child) => !before.has(child)) ?? []) {
      removeNode(node);
    }
  };
  instance.$set = (props) => {
    const update = exports.$set;
    if (typeof update === "function") update(props);
  };
  instance.$on = () => () => {};
  return instance;
}
