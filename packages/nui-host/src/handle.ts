import { Common } from "@nexa/protocol";

type HandleRecord = Record<string, unknown>;

function isRecord(value: unknown): value is HandleRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUint32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

export function isHandleRef(value: unknown): value is Common.HandleRef {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.length === 2 &&
    keys[0] === "generation" &&
    keys[1] === "slot" &&
    isUint32(value.slot) &&
    isUint32(value.generation) &&
    value.generation >= Common.handleValidation.generationMinimum
  );
}

/** Convert an internal legacy packed node id without exposing it on the v1 API. */
export function handleRefFromLegacyPacked(raw: bigint): Common.HandleRef {
  const maximum = 0xffff_ffff_ffff_ffffn;
  if (raw < 0n || raw > maximum) {
    throw new RangeError("legacy node handle must be an unsigned 64-bit integer");
  }
  const handle = {
    slot: Number(raw & 0xffff_ffffn),
    generation: Number(raw >> 32n),
  } as Common.HandleRef;
  if (!isHandleRef(handle)) {
    throw new TypeError("legacy node handle contains an invalid generation");
  }
  return handle;
}

/** Encode a validated logical HandleRef using the canonical v1 token. */
export function encodeHandleToken(handle: Common.HandleRef): string {
  if (!isHandleRef(handle)) {
    throw new TypeError("HandleRef must contain only uint32 slot and generation fields");
  }
  return `h1/${handle.slot.toString(16).padStart(8, "0")}/${handle.generation
    .toString(16)
    .padStart(8, "0")}`;
}

/** Decode a canonical v1 token and reject every non-canonical representation. */
export function decodeHandleToken(token: string): Common.HandleRef {
  const parts = typeof token === "string" ? token.split("/") : [];
  const slotToken = parts[1];
  const generationToken = parts[2];
  const isLowerHex = (value: string | undefined): value is string => {
    if (value === undefined || value.length !== 8) return false;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) return false;
    }
    return true;
  };
  if (
    parts.length !== 3 ||
    parts[0] !== "h1" ||
    !isLowerHex(slotToken) ||
    !isLowerHex(generationToken)
  ) {
    throw new TypeError("Handle token must match h1/<8 lowercase hex>/<8 lowercase hex>");
  }
  const generation = Number.parseInt(generationToken, 16);
  if (generation < Common.handleValidation.generationMinimum) {
    throw new TypeError("Handle token generation must be non-zero");
  }
  return {
    slot: Number.parseInt(slotToken, 16),
    generation,
  } as Common.HandleRef;
}
