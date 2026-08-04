export type HostPropRecord = Readonly<Record<string, unknown>>;
export type HostPropChange = readonly [name: string, value: unknown];

const hasOwn = (record: HostPropRecord, name: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, name);

/** Return changed keys, representing a removed key as an explicit null clear. */
export function diffPropRecord(previous: HostPropRecord, next: HostPropRecord): HostPropChange[] {
  const changes: HostPropChange[] = [];
  for (const name of Object.keys(previous)) {
    if (!hasOwn(next, name)) {
      changes.push([name, null]);
    } else if (!Object.is(previous[name], next[name])) {
      changes.push([name, next[name]]);
    }
  }
  for (const name of Object.keys(next)) {
    if (!hasOwn(previous, name)) changes.push([name, next[name]]);
  }
  return changes;
}
