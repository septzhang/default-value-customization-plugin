import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildDefaultFieldName,
  buildFieldDescription,
  buildRefreshPlan,
  buildRecordUpdates,
  deriveTargetTypeFromSource,
  isCompatibleSource
} from "../../shared/src/defaultValue";
import type {
  AutoFillLogEntry,
  DefaultValueConfig,
  FieldOption,
  RefreshStrategy,
  RefreshSummary,
  StorageScope,
  SupportedTargetType
} from "../../shared/src/types";
import {
  addTargetField,
  createMissingOptions,
  detectRuntimeState,
  getBitableContext,
  getTargetFieldOptions,
  listFields,
  loadAutoLogs,
  loadSummary,
  readAllRecordSnapshots,
  saveConfig,
  saveSummary,
  updateFieldDescription,
  writeRecordUpdates,
  type BitableContext
} from "./bitableClient";

type RunState = "loading" | "ready" | "writing" | "done" | "error";

const TARGET_TYPE_LABELS: Record<SupportedTargetType, string> = {
  text: "文本",
  number: "数字",
  date: "日期",
  singleSelect: "单选",
  multiSelect: "多选",
  checkbox: "复选框"
};

export function App() {
  const [state, setState] = useState<RunState>("loading");
  const [context, setContext] = useState<BitableContext>();
  const [fields, setFields] = useState<FieldOption[]>([]);
  const [sourceFieldId, setSourceFieldId] = useState("");
  const [targetType, setTargetType] = useState<SupportedTargetType>("text");
  const [targetFieldName, setTargetFieldName] = useState("");
  const [targetFieldId, setTargetFieldId] = useState("");
  const [autoFillEnabled, setAutoFillEnabled] = useState(true);
  const [refreshStrategy, setRefreshStrategy] = useState<RefreshStrategy>("fillEmpty");
  const [storageScope, setStorageScope] = useState<StorageScope>("local");
  const [summary, setSummary] = useState<RefreshSummary>();
  const [autoLogs, setAutoLogs] = useState<AutoFillLogEntry[]>([]);
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const stopRequested = useRef(false);

  useEffect(() => {
    getBitableContext()
      .then(async (nextContext) => {
        const nextFields = await listFields(nextContext.table);
        const firstSource = nextFields.find((field) => field.type !== "unsupported");
        setContext(nextContext);
        setFields(nextFields);
        setSourceFieldId(firstSource?.id ?? "");
        setTargetFieldName(firstSource ? buildDefaultFieldName(firstSource.name, nextFields.map((field) => field.name)) : "");
        setState("ready");
      })
      .catch((error) => {
        setState("error");
        setMessage(error instanceof Error ? error.message : "加载多维表格上下文失败");
      });
  }, []);

  useEffect(() => {
    if (!sourceFieldId || targetFieldId) return;
    const source = fields.find((field) => field.id === sourceFieldId);
    if (source) {
      setTargetFieldName(buildDefaultFieldName(source.name, fields.map((field) => field.name)));
    }
  }, [fields, sourceFieldId, targetFieldId]);

  useEffect(() => {
    if (!context || !targetFieldId) return;
    setSummary(loadSummary(context, targetFieldId));
    setAutoLogs(loadAutoLogs(context, targetFieldId));
  }, [context, targetFieldId]);

  const sourceField = useMemo(() => fields.find((field) => field.id === sourceFieldId), [fields, sourceFieldId]);
  const sourceFields = useMemo(() => fields.filter((field) => deriveTargetTypeFromSource(field)), [fields]);
  const derivedTargetType = deriveTargetTypeFromSource(sourceField);
  const effectiveTargetType = derivedTargetType ?? targetType;
  const compatible = sourceField && derivedTargetType ? isCompatibleSource(sourceField, effectiveTargetType) : false;
  const runtimeState = detectRuntimeState(storageScope, Boolean(targetFieldId && compatible));

  async function handleCreateField() {
    if (!context || !sourceField) return;
    if (!targetFieldName.trim()) {
      setMessage("请填写新字段名称");
      return;
    }
    if (!compatible) {
      setMessage("请选择支持的来源字段。查找字段请先通过飞书多维表格转换成目标类型后再使用。");
      return;
    }

    setState("loading");
    setMessage("");

    try {
      const now = new Date().toISOString();
      const nextTargetFieldId = await addTargetField(context.table, targetFieldName.trim(), effectiveTargetType);
      const config: DefaultValueConfig = {
        sourceFieldId,
        targetFieldId: nextTargetFieldId,
        targetType: effectiveTargetType,
        autoFillEnabled,
        defaultRefreshStrategy: refreshStrategy,
        createdAt: now,
        updatedAt: now
      };
      const scope = await saveConfig(context, config);
      await updateFieldDescription(context.table, nextTargetFieldId, buildFieldDescription(sourceField.name, autoFillEnabled, refreshStrategy));
      const nextFields = await listFields(context.table);
      setFields(nextFields);
      setTargetFieldId(nextTargetFieldId);
      setStorageScope(scope);
      setState("ready");
      setTargetType(effectiveTargetType);
      setMessage("字段已创建，目标字段类型已与来源字段保持一致。历史记录不会自动写入，可点击“刷新历史记录”处理。");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "创建默认值字段失败");
    }
  }

  async function handleSaveConfig() {
    if (!context || !sourceField || !targetFieldId) return;
    if (!compatible) {
      setMessage("当前配置失效：来源字段类型不受支持");
      return;
    }

    const now = new Date().toISOString();
    const config: DefaultValueConfig = {
      sourceFieldId,
      targetFieldId,
      targetType: effectiveTargetType,
      autoFillEnabled,
      defaultRefreshStrategy: refreshStrategy,
      createdAt: now,
      updatedAt: now
    };
    const scope = await saveConfig(context, config);
    await updateFieldDescription(context.table, targetFieldId, buildFieldDescription(sourceField.name, autoFillEnabled, refreshStrategy));
    setStorageScope(scope);
    setMessage("配置已保存。如需更新已有记录，请点击“刷新历史记录”。");
  }

  async function handleRefreshHistory() {
    if (!context || !targetFieldId) return;
    setState("writing");
    setMessage("");
    setProgress({ done: 0, total: 0 });
    stopRequested.current = false;

    try {
      const snapshots = await readAllRecordSnapshots(context.table, sourceFieldId, targetFieldId);
      const plan = buildRefreshPlan({
        records: snapshots,
        targetFieldId,
        targetType: effectiveTargetType,
        targetOptions: getTargetFieldOptions(fields, targetFieldId),
        strategy: refreshStrategy,
        allowCreateOptions: true
      });

      const shouldContinue = confirmRun(plan.totalRecords, plan.updateCount, refreshStrategy);
      if (!shouldContinue) {
        setState("ready");
        return;
      }

      if (plan.optionCreationPlan.some((item) => item.optionNames.length > 0)) {
        const optionCount = plan.optionCreationPlan.reduce((sum, item) => sum + item.optionNames.length, 0);
        const confirmed = window.confirm(`本次将新增 ${optionCount} 个选项并写入 ${plan.updateCount} 条记录。确认继续吗？`);
        if (!confirmed) {
          setState("ready");
          return;
        }
      }

      const createdOptionCount = await createMissingOptions(context.table, plan.optionCreationPlan);
      const updates = buildRecordUpdates(plan, targetFieldId);
      setProgress({ done: 0, total: updates.length });
      const result = await writeRecordUpdates(context.table, updates, (done, total) => {
        setProgress({ done, total });
        return !stopRequested.current;
      });
      const nextSummary: RefreshSummary = {
        executedAt: new Date().toISOString(),
        strategy: refreshStrategy,
        totalRecords: plan.totalRecords,
        updatedCount: result.updatedCount,
        createdOptionCount,
        skipCount: plan.skipCount,
        sameCount: plan.sameCount,
        failedCount: result.failedCount,
        stoppedByUser: result.stoppedByUser,
        reasons: plan.reasons
      };
      saveSummary(context, targetFieldId, nextSummary);
      setSummary(nextSummary);
      setState("done");
      setMessage(result.stoppedByUser ? "已停止执行，已完成的写入不会撤回。" : "刷新完成。");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "执行刷新失败");
    }
  }

  function handleStop() {
    stopRequested.current = true;
  }

  return (
    <main className="shell">
      <header className="header">
        <div>
          <h1>默认值自定义</h1>
          <p>从已有字段取值，自动填充新字段默认值。</p>
        </div>
      </header>

      {message && <div className={state === "error" ? "notice error" : "notice"}>{message}</div>}

      <section className="panel">
        <div className="panel-title">
          <h2>{targetFieldId ? "字段配置" : "新建默认值字段"}</h2>
          {targetFieldId && <span className="badge">已创建</span>}
        </div>

        <label>
          来源字段
          <select value={sourceFieldId} onChange={(event) => setSourceFieldId(event.target.value)}>
            {sourceFields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
                {field.type === "lookup" ? "（查找）" : ""}
              </option>
            ))}
          </select>
        </label>

        <p className="hint">目标字段类型将与来源字段保持一致。需要更改类型时，请使用飞书多维表格原生字段类型能力。</p>

        <div className="field-readout">
          <span>目标字段类型</span>
          <strong>{derivedTargetType ? TARGET_TYPE_LABELS[derivedTargetType] : "不支持"}</strong>
        </div>

        {!compatible && <p className="error-text">该来源字段类型不支持。查找字段请先在飞书多维表格中转换为目标类型后再使用。</p>}

        <label>
          新字段名称
          <input value={targetFieldName} disabled={Boolean(targetFieldId)} onChange={(event) => setTargetFieldName(event.target.value)} />
        </label>

        <div className="row">
          <span>新增记录自动填充</span>
          <label className="switch">
            <input type="checkbox" checked={autoFillEnabled} onChange={(event) => setAutoFillEnabled(event.target.checked)} />
            <span>{autoFillEnabled ? "开启" : "关闭"}</span>
          </label>
        </div>

        <fieldset>
          <legend>手动刷新默认策略</legend>
          <label className="radio">
            <input
              type="radio"
              name="strategy"
              checked={refreshStrategy === "fillEmpty"}
              onChange={() => setRefreshStrategy("fillEmpty")}
            />
            仅填充空值
          </label>
          <label className="radio">
            <input
              type="radio"
              name="strategy"
              checked={refreshStrategy === "overwrite"}
              onChange={() => setRefreshStrategy("overwrite")}
            />
            覆盖已有值
          </label>
        </fieldset>

        <div className="actions">
          {!targetFieldId ? (
            <button onClick={handleCreateField} disabled={state === "loading" || !compatible}>
              创建字段
            </button>
          ) : (
            <>
              <button className="secondary" onClick={handleSaveConfig} disabled={!compatible}>
                保存配置
              </button>
              <button onClick={handleRefreshHistory} disabled={state === "writing" || !compatible}>
                {state === "writing" ? "刷新中..." : "刷新历史记录"}
              </button>
            </>
          )}
        </div>
      </section>

      <section className="status-grid">
        <Status label="配置保存" value={runtimeState.storageScope === "field" ? "字段级" : "本机浏览器"} />
        <Status label="自动填充" value={autoFillEnabled ? "已开启" : "已关闭"} />
        <Status label="当前配置" value={runtimeState.configStatus === "valid" ? "有效" : "失效"} />
        <Status label="权限状态" value={runtimeState.permissionStatus === "normal" ? "正常" : "权限不足"} />
      </section>

      {storageScope === "local" && (
        <p className="hint">当前配置仅保存在本机浏览器，自动填充仅在你打开此字段配置时生效。</p>
      )}

      {state === "writing" && (
        <section className="panel">
          <div className="panel-title">
            <h2>正在刷新历史记录</h2>
          </div>
          <p className="hint">执行进度：{progress.done} / {progress.total}</p>
          <div className="actions">
            <button className="secondary" onClick={handleStop}>
              停止执行
            </button>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-title">
          <h2>最近状态</h2>
        </div>
        {summary ? (
          <div className="summary">
            <p>上次刷新：{new Date(summary.executedAt).toLocaleString()}</p>
            <p>
              更新 {summary.updatedCount} 条，新增选项 {summary.createdOptionCount} 个，跳过 {summary.skipCount} 条，
              无需变更 {summary.sameCount} 条，失败 {summary.failedCount} 条。
            </p>
          </div>
        ) : (
          <p className="hint">暂无手动刷新结果。</p>
        )}

        {autoLogs.length > 0 && (
          <div className="auto-log">
            <strong>最近自动填充日志</strong>
            <ul>
              {autoLogs.slice(-5).map((log, index) => (
                <li key={`${log.occurredAt}-${index}`}>
                  {new Date(log.occurredAt).toLocaleString()}：{log.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </main>
  );
}

function confirmRun(totalRecords: number, updateCount: number, strategy: RefreshStrategy): boolean {
  const strategyText = strategy === "fillEmpty" ? "仅填充空值" : "覆盖已有值";
  if (strategy === "overwrite") {
    const confirmed = window.confirm(`本次将按“${strategyText}”策略刷新历史记录，预计写入 ${updateCount} 条。来源为空不会清空目标字段。是否继续？`);
    if (!confirmed) return false;
  }
  if (totalRecords > 50000) {
    return window.confirm("本次将处理超过 50,000 条记录。纯前端执行可能耗时较长，期间请勿关闭页面或切换字段配置；如果中断，可能只完成部分记录。是否继续？");
  }
  if (totalRecords > 5000) {
    return window.confirm("本次处理记录数较多，执行可能耗时较长。是否继续？");
  }
  return true;
}

function Status({ label, value }: { label: string; value: string }) {
  return (
    <div className="status-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
