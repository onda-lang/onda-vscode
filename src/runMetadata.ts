export type RunScalarValue = boolean | number | null;

export interface NormalizedRunParamPayload {
  index: number;
  name: string;
  type: string;
  value: RunScalarValue;
  default: number | null;
  rangeMin: number | null;
  rangeMax: number | null;
  scale: string | null;
  curve: number | null;
  unit: string | null;
  step: number | null;
  stepCount: number | null;
  scalar: boolean;
}

export function normalizeRunParams(raw: unknown): NormalizedRunParamPayload[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  return raw.map(normalizeRunParam);
}

export function initialRunParamValue(
  param: Pick<NormalizedRunParamPayload, "type" | "value" | "default" | "rangeMin">,
): RunScalarValue {
  if (param.value !== null && param.value !== undefined) {
    if (param.type === "bool") {
      return typeof param.value === "boolean" ? param.value : param.value !== 0;
    }
    return param.value;
  }
  if (param.type === "bool") {
    return param.default !== null && param.default !== undefined
      ? param.default !== 0
      : false;
  }
  if (param.default !== null && param.default !== undefined) {
    return param.default;
  }
  if (param.rangeMin !== null && param.rangeMin !== undefined) {
    return param.rangeMin;
  }
  return 0;
}

function normalizeRunParam(raw: unknown): NormalizedRunParamPayload {
  const source = isRecord(raw) ? raw : {};
  const type = stringField(source, ["type", "type_repr"]) ?? "f32";
  return {
    index: numberField(source, ["index"]) ?? 0,
    name: stringField(source, ["name"]) ?? "",
    type,
    value: scalarField(source, type, ["value"], ["valueRepr", "value_repr"]),
    default: defaultField(source, type),
    rangeMin: numberField(
      source,
      ["rangeMin", "range_min"],
      ["rangeMinRepr", "range_min_repr"],
    ),
    rangeMax: numberField(
      source,
      ["rangeMax", "range_max"],
      ["rangeMaxRepr", "range_max_repr"],
    ),
    scale: stringField(source, ["scale"]),
    curve: numberField(source, ["curve"], ["curveRepr", "curve_repr"]),
    unit: stringField(source, ["unit"]),
    step: numberField(source, ["step"], ["stepRepr", "step_repr"]),
    stepCount: numberField(source, ["stepCount", "step_count"]),
    scalar: source.scalar !== false,
  };
}

function defaultField(
  source: Record<string, unknown>,
  type: string,
): number | null {
  if (type !== "bool") {
    return numberField(source, ["default"], ["defaultRepr", "default_repr"]);
  }
  const value = scalarField(
    source,
    type,
    ["default"],
    ["defaultRepr", "default_repr"],
  );
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return typeof value === "number" ? value : null;
}

function scalarField(
  source: Record<string, unknown>,
  type: string,
  valueKeys: string[],
  reprKeys: string[],
): RunScalarValue {
  const direct = firstDefined(source, valueKeys);
  if (typeof direct === "boolean" || typeof direct === "number") {
    return direct;
  }
  const repr = firstDefined(source, reprKeys);
  if (typeof repr !== "string") {
    return null;
  }
  if (type === "bool") {
    if (repr === "true" || repr === "1") {
      return true;
    }
    if (repr === "false" || repr === "0") {
      return false;
    }
    return null;
  }
  const value = Number(repr);
  return Number.isFinite(value) ? value : null;
}

function numberField(
  source: Record<string, unknown>,
  valueKeys: string[],
  reprKeys: string[] = [],
): number | null {
  const direct = firstDefined(source, valueKeys);
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return direct;
  }
  const repr = firstDefined(source, reprKeys);
  if (typeof repr !== "string") {
    return null;
  }
  const value = Number(repr);
  return Number.isFinite(value) ? value : null;
}

function stringField(
  source: Record<string, unknown>,
  keys: string[],
): string | null {
  const value = firstDefined(source, keys);
  return typeof value === "string" ? value : null;
}

function firstDefined(
  source: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
