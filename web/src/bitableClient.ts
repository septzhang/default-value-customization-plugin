import { bitable } from "@lark-base-open/js-sdk";
import type {
  AutoFillLogEntry,
  DefaultValueConfig,
  FieldOption,
  OptionCreationPlan,
  RecordSnapshot,
  RefreshSummary,
  SelectOption,
  SourceFieldKind,
  StorageScope,
  SupportedTargetType
} from "../../shared/src/types";

const FIELD_TYPE_BY_CODE = new Map<number, SourceFieldKind>([
  [1, "text"],
  [2, "number"],
  [3, "singleSelect"],
  [4, "multiSelect"],
  [5, "date"],
  [7, "checkbox"],
  [15, "lookup"]
]);

const TARGET_FIELD_CODE: Record<SupportedTargetType, number> = {
  text: 1,
  number: 2,
  singleSelect: 3,
  multiSelect: 4,
  date: 5,
  checkbox: 7
};

const CONFIG_PREFIX = "default-value-customization";

export interface BitableContext {
  baseId: string;
  tableId: string;
  table: any;
}

export interface RuntimeState {
  storageScope: StorageScope;
  configStatus: "valid" | "invalid";
  permissionStatus: "normal" | "denied";
}

export async function getBitableContext(): Promise<BitableContext> {
  const table = await bitable.base.getActiveTable();
  const tableLike = table as any;
  const tableId = tableLike.id ?? (typeof tableLike.getId === "function" ? await tableLike.getId() : "active-table");
  const baseId =
    typeof bitable.base.getSelection === "function"
      ? (await bitable.base.getSelection())?.baseId ?? "active-base"
      : "active-base";
  return { baseId, tableId, table };
}

export async function listFields(table: any): Promise<FieldOption[]> {
  const metas = await table.getFieldMetaList();
  return metas.map((meta: any) => ({
    id: meta.id,
    name: meta.name,
    type: mapFieldType(meta.type),
    options: normalizeOptions(meta.property?.options ?? meta.options ?? meta.property?.items)
  }));
}

export async function addTargetField(table: any, name: string, type: SupportedTargetType): Promise<string> {
  const created = await table.addField({
    type: TARGET_FIELD_CODE[type],
    name
  });
  return typeof created === "string" ? created : created.id;
}

export async function updateFieldDescription(table: any, fieldId: string, description: string): Promise<void> {
  const field = await getField(table, fieldId);
  if (field && typeof field.setDescription === "function") {
    await field.setDescription(description);
    return;
  }
  if (field && typeof field.updateMeta === "function") {
    await field.updateMeta({ description });
  }
}

export async function readAllRecordSnapshots(table: any, sourceFieldId: string, targetFieldId: string): Promise<RecordSnapshot[]> {
  const recordIds = await getAllRecordIds(table);
  const snapshots: RecordSnapshot[] = [];

  for (const recordId of recordIds) {
    snapshots.push({
      recordId,
      sourceValue: await table.getCellValue(sourceFieldId, recordId),
      targetValue: await table.getCellValue(targetFieldId, recordId)
    });
  }

  return snapshots;
}

export async function writeRecordUpdates(
  table: any,
  updates: Array<{ recordId: string; fields: Record<string, unknown> }>,
  onProgress: (done: number, total: number) => boolean
): Promise<{ updatedCount: number; failedCount: number; stoppedByUser: boolean }> {
  const batchSize = 100;
  let updatedCount = 0;
  let failedCount = 0;

  for (let index = 0; index < updates.length; index += batchSize) {
    if (!onProgress(updatedCount, updates.length)) {
      return { updatedCount, failedCount, stoppedByUser: true };
    }

    const batch = updates.slice(index, index + batchSize);
    const ok = await retry(() => writeBatch(table, batch), 2);
    if (ok) {
      updatedCount += batch.length;
    } else {
      failedCount += batch.length;
    }
    onProgress(updatedCount, updates.length);
  }

  return { updatedCount, failedCount, stoppedByUser: false };
}

export async function createMissingOptions(table: any, plans: OptionCreationPlan[]): Promise<number> {
  let createdCount = 0;
  for (const plan of plans) {
    if (plan.optionNames.length === 0) continue;
    const field = await getField(table, plan.fieldId);
    if (!field) continue;

    if (typeof field.addOptions === "function") {
      await field.addOptions(plan.optionNames.map((name) => ({ name })));
      createdCount += plan.optionNames.length;
      continue;
    }
    if (typeof field.updateProperty === "function") {
      const meta = typeof field.getMeta === "function" ? await field.getMeta() : {};
      const currentOptions = normalizeOptions(meta.property?.options ?? meta.options);
      await field.updateProperty({
        ...(meta.property ?? {}),
        options: [...currentOptions, ...plan.optionNames.map((name) => ({ name }))]
      });
      createdCount += plan.optionNames.length;
    }
  }
  return createdCount;
}

export async function saveConfig(context: BitableContext, config: DefaultValueConfig): Promise<StorageScope> {
  const field = await getField(context.table, config.targetFieldId);
  if (field && typeof field.setConfig === "function") {
    await field.setConfig(config);
    return "field";
  }

  localStorage.setItem(configKey(context, config.targetFieldId), JSON.stringify(config));
  return "local";
}

export async function loadConfig(context: BitableContext, fieldId: string): Promise<{ config?: DefaultValueConfig; scope: StorageScope }> {
  const field = await getField(context.table, fieldId);
  if (field && typeof field.getConfig === "function") {
    const config = await field.getConfig();
    if (config) return { config, scope: "field" };
  }

  const raw = localStorage.getItem(configKey(context, fieldId));
  return { config: raw ? (JSON.parse(raw) as DefaultValueConfig) : undefined, scope: "local" };
}

export function saveSummary(context: BitableContext, fieldId: string, summary: RefreshSummary): void {
  localStorage.setItem(`${configKey(context, fieldId)}:summary`, JSON.stringify(summary));
}

export function loadSummary(context: BitableContext, fieldId: string): RefreshSummary | undefined {
  const raw = localStorage.getItem(`${configKey(context, fieldId)}:summary`);
  return raw ? (JSON.parse(raw) as RefreshSummary) : undefined;
}

export function saveAutoLogs(context: BitableContext, fieldId: string, logs: AutoFillLogEntry[]): void {
  localStorage.setItem(`${configKey(context, fieldId)}:auto-logs`, JSON.stringify(logs));
}

export function loadAutoLogs(context: BitableContext, fieldId: string): AutoFillLogEntry[] {
  const raw = localStorage.getItem(`${configKey(context, fieldId)}:auto-logs`);
  return raw ? (JSON.parse(raw) as AutoFillLogEntry[]) : [];
}

export function getTargetFieldOptions(fields: FieldOption[], targetFieldId: string): SelectOption[] {
  return fields.find((field) => field.id === targetFieldId)?.options ?? [];
}

export function detectRuntimeState(storageScope: StorageScope, configValid: boolean): RuntimeState {
  return {
    storageScope,
    configStatus: configValid ? "valid" : "invalid",
    permissionStatus: "normal"
  };
}

function mapFieldType(type: unknown): SourceFieldKind {
  return FIELD_TYPE_BY_CODE.get(Number(type)) ?? "unsupported";
}

function normalizeOptions(value: unknown): SelectOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return { name: item };
      if (item && typeof item === "object" && "name" in item && typeof (item as { name?: unknown }).name === "string") {
        return { id: String((item as { id?: unknown }).id ?? ""), name: (item as { name: string }).name };
      }
      return undefined;
    })
    .filter((item): item is SelectOption => Boolean(item));
}

async function getAllRecordIds(table: any): Promise<string[]> {
  if (typeof table.getRecordIdList === "function") return table.getRecordIdList();
  if (typeof table.getRecordList === "function") {
    const records = await table.getRecordList();
    return records.map((record: any) => record.id);
  }
  return [];
}

async function getField(table: any, fieldId: string): Promise<any> {
  if (typeof table.getField === "function") return table.getField(fieldId);
  return undefined;
}

async function writeBatch(table: any, batch: Array<{ recordId: string; fields: Record<string, unknown> }>): Promise<void> {
  if (typeof table.setRecords === "function") {
    await table.setRecords(batch);
    return;
  }

  await Promise.all(
    batch.map((update) =>
      Promise.all(Object.entries(update.fields).map(([fieldId, value]) => table.setCellValue(fieldId, update.recordId, value)))
    )
  );
}

async function retry(task: () => Promise<void>, retryCount: number): Promise<boolean> {
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      await task();
      return true;
    } catch {
      if (attempt === retryCount) return false;
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1000 : 3000));
    }
  }
  return false;
}

function configKey(context: BitableContext, fieldId: string): string {
  return `${CONFIG_PREFIX}:${context.baseId}:${context.tableId}:${fieldId}`;
}
