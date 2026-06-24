export type SupportedTargetType = "text" | "number" | "date" | "singleSelect" | "multiSelect" | "checkbox";
export type SourceFieldKind = SupportedTargetType | "lookup" | "unsupported";
export type RefreshStrategy = "fillEmpty" | "overwrite";
export type StorageScope = "field" | "local";
export type ConfigStatus = "valid" | "invalid";

export interface FieldOption {
  id: string;
  name: string;
  type: SourceFieldKind;
  options?: SelectOption[];
}

export interface SelectOption {
  id?: string;
  name: string;
}

export interface DefaultValueConfig {
  sourceFieldId: string;
  targetFieldId: string;
  targetType: SupportedTargetType;
  autoFillEnabled: boolean;
  defaultRefreshStrategy: RefreshStrategy;
  createdAt: string;
  updatedAt: string;
}

export interface RecordSnapshot {
  recordId: string;
  sourceValue: unknown;
  targetValue: unknown;
}

export type RefreshDecisionStatus = "update" | "skip" | "same";

export interface RefreshDecision {
  recordId: string;
  status: RefreshDecisionStatus;
  reason: string;
  sourceValue: unknown;
  targetValue: unknown;
  nextValue?: unknown;
}

export interface OptionCreationPlan {
  fieldId: string;
  optionNames: string[];
}

export interface RefreshPlan {
  totalRecords: number;
  updateCount: number;
  fillEmptyCount: number;
  overwriteCount: number;
  skipCount: number;
  sameCount: number;
  optionCreationPlan: OptionCreationPlan[];
  reasons: Record<string, number>;
  rows: RefreshDecision[];
}

export interface RefreshSummary {
  executedAt: string;
  strategy: RefreshStrategy;
  totalRecords: number;
  updatedCount: number;
  createdOptionCount: number;
  skipCount: number;
  sameCount: number;
  failedCount: number;
  stoppedByUser: boolean;
  reasons: Record<string, number>;
}

export interface AutoFillLogEntry {
  recordId: string;
  status: "success" | "skipped" | "failed";
  reason: string;
  sourceValue?: unknown;
  occurredAt: string;
}
