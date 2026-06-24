import type {
  FieldOption,
  OptionCreationPlan,
  RefreshDecision,
  RefreshPlan,
  RecordSnapshot,
  RefreshStrategy,
  SelectOption,
  SourceFieldKind,
  SupportedTargetType
} from "./types";

const SUPPORTED_TARGET_TYPES: SupportedTargetType[] = ["text", "number", "date", "singleSelect", "multiSelect", "checkbox"];

export function getSupportedTargetTypes(): SupportedTargetType[] {
  return [...SUPPORTED_TARGET_TYPES];
}

export function buildDefaultFieldName(sourceFieldName: string, existingNames: string[]): string {
  const baseName = `${sourceFieldName.trim() || "字段"}默认值`;
  if (!existingNames.includes(baseName)) return baseName;

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseName} ${index}`;
    if (!existingNames.includes(candidate)) return candidate;
  }

  return `${baseName} ${Date.now()}`;
}

export function isSupportedTargetType(value: string): value is SupportedTargetType {
  return SUPPORTED_TARGET_TYPES.includes(value as SupportedTargetType);
}

export function deriveTargetTypeFromSource(source: FieldOption | undefined): SupportedTargetType | undefined {
  if (!source) return undefined;
  return isSupportedTargetType(source.type) ? source.type : undefined;
}

export function isCompatibleSource(source: FieldOption, targetType: SupportedTargetType): boolean {
  return deriveTargetTypeFromSource(source) === targetType;
}

export function buildRefreshPlan(params: {
  records: RecordSnapshot[];
  targetFieldId: string;
  targetType: SupportedTargetType;
  targetOptions?: SelectOption[];
  strategy: RefreshStrategy;
  allowCreateOptions: boolean;
}): RefreshPlan {
  const optionNames = new Set((params.targetOptions ?? []).map((option) => option.name));
  const rows = params.records.map((record) =>
    decideRecord({
      record,
      targetType: params.targetType,
      optionNames,
      strategy: params.strategy,
      allowCreateOptions: params.allowCreateOptions
    })
  );
  const optionCreationPlan = buildOptionCreationPlan(params.targetFieldId, params.targetType, rows, optionNames);
  const reasons = summarizeReasons(rows);

  return {
    totalRecords: params.records.length,
    updateCount: rows.filter((row) => row.status === "update").length,
    fillEmptyCount: rows.filter((row) => row.status === "update" && isEmptyValue(row.targetValue)).length,
    overwriteCount: rows.filter((row) => row.status === "update" && !isEmptyValue(row.targetValue)).length,
    skipCount: rows.filter((row) => row.status === "skip").length,
    sameCount: rows.filter((row) => row.status === "same").length,
    optionCreationPlan,
    reasons,
    rows
  };
}

export function buildRecordUpdates(plan: RefreshPlan, targetFieldId: string): Array<{ recordId: string; fields: Record<string, unknown> }> {
  return plan.rows
    .filter((row) => row.status === "update")
    .map((row) => ({
      recordId: row.recordId,
      fields: {
        [targetFieldId]: row.nextValue
      }
    }));
}

export function buildFieldDescription(sourceFieldName: string, autoFillEnabled: boolean, defaultRefreshStrategy: RefreshStrategy): string {
  const autoFillText = autoFillEnabled ? "新增记录时自动填充" : "新增记录时不自动填充";
  const strategyText = defaultRefreshStrategy === "fillEmpty" ? "手动刷新默认仅填充空值" : "手动刷新默认覆盖已有值";
  return `默认值字段：来源「${sourceFieldName}」。${autoFillText}；${strategyText}。`;
}

export function capRecentLogs<T>(logs: T[], limit = 100): T[] {
  return logs.slice(-limit);
}

export function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

function decideRecord(params: {
  record: RecordSnapshot;
  targetType: SupportedTargetType;
  optionNames: Set<string>;
  strategy: RefreshStrategy;
  allowCreateOptions: boolean;
}): RefreshDecision {
  const { record, strategy } = params;

  if (isEmptyValue(record.sourceValue)) {
    return skip(record, "来源为空");
  }
  if (strategy === "fillEmpty" && !isEmptyValue(record.targetValue)) {
    return skip(record, "目标已有值");
  }

  const normalized = normalizeValue(record.sourceValue, params.targetType);
  if (!normalized.ok) {
    return skip(record, normalized.reason);
  }

  const optionCheck = checkSelectOptions(normalized.value, params.targetType, params.optionNames, params.allowCreateOptions);
  if (!optionCheck.ok) {
    return skip(record, optionCheck.reason);
  }

  if (valuesEqual(record.targetValue, normalized.value)) {
    return {
      recordId: record.recordId,
      status: "same",
      reason: "无需变更",
      sourceValue: record.sourceValue,
      targetValue: record.targetValue,
      nextValue: normalized.value
    };
  }

  return {
    recordId: record.recordId,
    status: "update",
    reason: isEmptyValue(record.targetValue) ? "填充空值" : "覆盖已有值",
    sourceValue: record.sourceValue,
    targetValue: record.targetValue,
    nextValue: normalized.value
  };
}

function normalizeValue(value: unknown, targetType: SupportedTargetType): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (targetType === "multiSelect") {
    const values = Array.isArray(value) ? value : [value];
    const names = values.map(extractDisplayValue).filter((item): item is string => Boolean(item));
    if (names.length === 0) return { ok: false, reason: "来源为空" };
    return { ok: true, value: names };
  }

  if (Array.isArray(value)) {
    if (value.length !== 1) return { ok: false, reason: "多值不能写入该目标类型" };
    return normalizeValue(value[0], targetType);
  }

  if (targetType === "text") {
    return typeof value === "string" ? { ok: true, value } : { ok: false, reason: "来源类型不兼容" };
  }
  if (targetType === "number") {
    return typeof value === "number" && Number.isFinite(value) ? { ok: true, value } : { ok: false, reason: "来源类型不兼容" };
  }
  if (targetType === "date") {
    return typeof value === "number" || value instanceof Date ? { ok: true, value } : { ok: false, reason: "来源类型不兼容" };
  }
  if (targetType === "checkbox") {
    return typeof value === "boolean" ? { ok: true, value } : { ok: false, reason: "来源类型不兼容" };
  }
  if (targetType === "singleSelect") {
    const name = extractDisplayValue(value);
    return name ? { ok: true, value: name } : { ok: false, reason: "来源类型不兼容" };
  }

  return { ok: false, reason: "目标类型不支持" };
}

function extractDisplayValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "object" && value !== null && "text" in value && typeof (value as { text?: unknown }).text === "string") {
    return (value as { text: string }).text.trim() || undefined;
  }
  if (typeof value === "object" && value !== null && "name" in value && typeof (value as { name?: unknown }).name === "string") {
    return (value as { name: string }).name.trim() || undefined;
  }
  return undefined;
}

function checkSelectOptions(
  value: unknown,
  targetType: SupportedTargetType,
  optionNames: Set<string>,
  allowCreateOptions: boolean
): { ok: true } | { ok: false; reason: string } {
  if (targetType !== "singleSelect" && targetType !== "multiSelect") return { ok: true };

  const values = Array.isArray(value) ? value : [value];
  const missing = values.filter((item) => typeof item === "string" && !optionNames.has(item));
  if (missing.length === 0 || allowCreateOptions) return { ok: true };
  return { ok: false, reason: "目标字段缺少选项" };
}

function buildOptionCreationPlan(
  targetFieldId: string,
  targetType: SupportedTargetType,
  rows: RefreshDecision[],
  optionNames: Set<string>
): OptionCreationPlan[] {
  if (targetType !== "singleSelect" && targetType !== "multiSelect") return [];

  const nextOptions = new Set<string>();
  rows
    .filter((row) => row.status === "update")
    .flatMap((row) => (Array.isArray(row.nextValue) ? row.nextValue : [row.nextValue]))
    .forEach((value) => {
      if (typeof value === "string" && value && !optionNames.has(value)) {
        nextOptions.add(value);
      }
    });

  return nextOptions.size > 0 ? [{ fieldId: targetFieldId, optionNames: [...nextOptions] }] : [];
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    const leftValues = Array.isArray(left) ? left : [left];
    const rightValues = Array.isArray(right) ? right : [right];
    return JSON.stringify(leftValues) === JSON.stringify(rightValues);
  }
  return left === right;
}

function skip(record: RecordSnapshot, reason: string): RefreshDecision {
  return {
    recordId: record.recordId,
    status: "skip",
    reason,
    sourceValue: record.sourceValue,
    targetValue: record.targetValue
  };
}

function summarizeReasons(rows: RefreshDecision[]): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.reason] = (acc[row.reason] ?? 0) + 1;
    return acc;
  }, {});
}
