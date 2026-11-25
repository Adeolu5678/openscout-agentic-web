import { isPlainObject } from "./spec";

const BAD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SUPPORTED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "format",
  "title",
  "description",
  "default"
]);

export type ActionEffect = "read" | "write" | "irreversible";
export type ActionAvailability = "local-only" | "bridge" | "top-level";

export interface ActionExecutionContext {
  requestId: string;
  signal: AbortSignal;
}

export interface SiteActionDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  effect?: ActionEffect;
  availability?: ActionAvailability;
  callerOrigins?: string[];
  timeoutMs?: number;
  execute: (args: Record<string, unknown>, ctx: ActionExecutionContext) => Promise<unknown> | unknown;
}

export interface RegisteredAction {
  ref: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  effect: ActionEffect;
  availability: ActionAvailability;
  callerOrigins: string[];
  timeoutMs: number;
  base: string;
  network: string;
  execute: (args: Record<string, unknown>, ctx: ActionExecutionContext) => Promise<unknown> | unknown;
}

export interface ActionConfirmationItem {
  action: string;
  description: string;
  origin: string;
  effect: ActionEffect;
  arguments: Record<string, unknown>;
}

export interface ActionReceipt {
  action: string;
  requestId: string;
  status: "succeeded" | "unknown" | "cancelled";
  result?: unknown;
  error?: string;
}

export function cloneData<T>(value: T): T {
  const text = JSON.stringify(value);
  if (text === undefined || text.length > 65536) {
    throw new Error("Action data exceeds 64 KB limit.");
  }
  return JSON.parse(text, (key, val) => {
    if (BAD_KEYS.has(key)) {
      throw new Error(`Unsafe object key: ${key}`);
    }
    return val;
  }) as T;
}

export function checkSchema(schema: unknown, depth = 0): void {
  if (!isPlainObject(schema) || depth > 8) {
    throw new Error("Invalid action schema.");
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key) && !key.startsWith("x-")) {
      throw new Error(`Unsupported action schema keyword: ${key}`);
    }
  }
  const type = schema.type;
  if (!["object", "array", "string", "integer", "number", "boolean"].includes(String(type))) {
    throw new Error("Action schema requires a supported type.");
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new Error("Invalid enum.");
  }
  if (schema.format !== undefined && !["date", "email"].includes(String(schema.format))) {
    throw new Error("Supported formats: date, email.");
  }
  if (type === "object") {
    if (!isPlainObject(schema.properties)) {
      throw new Error("Object schema requires properties.");
    }
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
      throw new Error("Action objects must reject extra fields.");
    }
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        schema.required.some((k) => !Object.hasOwn(schema.properties as Record<string, unknown>, String(k))))
    ) {
      throw new Error("Invalid required fields.");
    }
    for (const prop of Object.values(schema.properties)) {
      checkSchema(prop, depth + 1);
    }
  }
  if (type === "array") {
    checkSchema(schema.items, depth + 1);
  }
}

export function validateData(schema: Record<string, unknown>, value: unknown, path = "arguments"): void {
  if (schema.type === "object") {
    if (!isPlainObject(value)) throw new Error(`Invalid ${path}.`);
    const props = (schema.properties || {}) as Record<string, Record<string, unknown>>;
    const required = (schema.required || []) as string[];
    for (const key of required) {
      if (!Object.hasOwn(value, key)) throw new Error(`Missing ${path}.${key}.`);
    }
    for (const [key, val] of Object.entries(value)) {
      if (BAD_KEYS.has(key) || !Object.hasOwn(props, key)) {
        throw new Error(`Unexpected ${path}.${key}.`);
      }
      validateData(props[key], val, `${path}.${key}`);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`Invalid ${path}.`);
    const minItems = typeof schema.minItems === "number" ? schema.minItems : 0;
    const maxItems = typeof schema.maxItems === "number" ? schema.maxItems : 1000;
    if (value.length < minItems || value.length > maxItems) throw new Error(`Invalid ${path}.`);
    const items = schema.items as Record<string, unknown>;
    value.forEach((v, i) => validateData(items, v, `${path}[${i}]`));
  } else if (schema.type === "integer" || schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid ${path}.`);
    if (schema.type === "integer" && !Number.isInteger(value)) throw new Error(`Invalid ${path}.`);
    const min = typeof schema.minimum === "number" ? schema.minimum : -Infinity;
    const max = typeof schema.maximum === "number" ? schema.maximum : Infinity;
    if (value < min || value > max) throw new Error(`Invalid ${path}.`);
  } else if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`Invalid ${path}.`);
    const minLength = typeof schema.minLength === "number" ? schema.minLength : 0;
    const maxLength = typeof schema.maxLength === "number" ? schema.maxLength : 65536;
    if (value.length < minLength || value.length > maxLength) throw new Error(`Invalid ${path}.`);
  } else if (typeof value !== "boolean") {
    throw new Error(`Invalid ${path}.`);
  }

  if (Array.isArray(schema.enum)) {
    const serialized = JSON.stringify(value);
    if (!schema.enum.some((opt) => JSON.stringify(opt) === serialized)) {
      throw new Error(`Value at ${path} is not in allowed enum.`);
    }
  }
}

export class ActionRegistry {
  private entries = new Map<string, RegisteredAction>();
  private completedReceipts = new Map<string, ActionReceipt>();

  register(scope: { base: string; network: string }, definition: SiteActionDefinition): string {
    const {
      name,
      description,
      inputSchema,
      outputSchema,
      effect = "write",
      availability = "local-only",
      callerOrigins = [],
      timeoutMs = 15000,
    } = cloneData({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      effect: definition.effect,
      availability: definition.availability,
      callerOrigins: definition.callerOrigins,
      timeoutMs: definition.timeoutMs,
    });

    if (!/^[A-Za-z][\w-]{0,79}$/.test(name || "") || !description || typeof definition.execute !== "function") {
      throw new Error("Action requires valid name, description, and execute handler.");
    }
    if (!["read", "write", "irreversible"].includes(effect)) {
      throw new Error(`Invalid action effect: ${effect}`);
    }
    if (!["local-only", "bridge", "top-level"].includes(availability)) {
      throw new Error(`Invalid action availability: ${availability}`);
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) {
      throw new Error("Action timeoutMs must be between 100 and 300000.");
    }
    checkSchema(inputSchema);
    if (inputSchema.type !== "object") {
      throw new Error("Action inputSchema must have type 'object'.");
    }
    if (outputSchema) checkSchema(outputSchema);

    const ref = `${scope.base.replace(/\/$/, "")}/${encodeURIComponent(scope.network)}#${name}`;
    this.entries.set(ref, {
      ref,
      name,
      description,
      inputSchema,
      outputSchema,
      effect,
      availability,
      callerOrigins,
      timeoutMs,
      base: scope.base,
      network: scope.network,
      execute: definition.execute,
    });
    return ref;
  }

  getByName(scope: { base: string; network: string }, name: string): RegisteredAction | null {
    const ref = `${scope.base.replace(/\/$/, "")}/${encodeURIComponent(scope.network)}#${name}`;
    return this.entries.get(ref) || null;
  }

  catalog(scope: { base: string; network: string }): Array<Omit<RegisteredAction, "execute" | "base" | "network" | "callerOrigins" | "timeoutMs" | "outputSchema">> {
    return [...this.entries.values()]
      .filter((e) => e.base === scope.base && e.network === scope.network)
      .map(({ ref, name, description, inputSchema, effect, availability }) =>
        cloneData({ ref, name, description, inputSchema, effect, availability })
      );
  }

  async invoke(
    scope: { base: string; network: string },
    name: string,
    rawArgs: Record<string, unknown>,
    requestId: string,
    confirmWrite: (items: ActionConfirmationItem[]) => Promise<boolean>
  ): Promise<ActionReceipt> {
    if (this.completedReceipts.has(requestId)) {
      return this.completedReceipts.get(requestId)!;
    }

    const entry = this.getByName(scope, name);
    if (!entry) {
      throw new Error(`Action '${name}' is not registered on ${scope.network}.`);
    }

    const args = cloneData(rawArgs || {});
    validateData(entry.inputSchema, args);

    if (entry.effect === "write" || entry.effect === "irreversible") {
      const origin = (() => {
        try {
          return new URL(entry.base).origin;
        } catch {
          return entry.base;
        }
      })();
      const approved = await confirmWrite([
        {
          action: entry.name,
          description: entry.description,
          origin,
          effect: entry.effect,
          arguments: cloneData(args),
        },
      ]);
      if (!approved) {
        return {
          action: entry.ref,
          requestId,
          status: "cancelled",
          error: "User declined write action confirmation.",
        };
      }
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const rawResult = await Promise.race([
        Promise.resolve().then(() =>
          entry.execute(cloneData(args), { requestId, signal: controller.signal })
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Action timed out; outcome unknown."));
          }, entry.timeoutMs);
        }),
      ]);
      const result = cloneData(rawResult);
      if (entry.outputSchema) validateData(entry.outputSchema, result, "result");
      const receipt: ActionReceipt = {
        action: entry.ref,
        requestId,
        status: "succeeded",
        result,
      };
      this.completedReceipts.set(requestId, receipt);
      return receipt;
    } catch (err) {
      const receipt: ActionReceipt = {
        action: entry.ref,
        requestId,
        status: "unknown",
        error: err instanceof Error ? err.message : String(err),
      };
      // Keep failed write requestId consumed so it cannot be silently retried.
      if (entry.effect !== "read") {
        this.completedReceipts.set(requestId, receipt);
      }
      return receipt;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
