import { describe, expect, it } from "vitest";
import { buildDefaultFieldName, buildRefreshPlan, buildRecordUpdates, deriveTargetTypeFromSource } from "../shared/src/defaultValue";

describe("default value rules", () => {
  it("builds unique default field names", () => {
    expect(buildDefaultFieldName("客户类型", [])).toBe("客户类型默认值");
    expect(buildDefaultFieldName("客户类型", ["客户类型默认值"])).toBe("客户类型默认值 2");
  });

  it("derives target type from supported source fields", () => {
    expect(deriveTargetTypeFromSource({ id: "fld1", name: "状态", type: "singleSelect" })).toBe("singleSelect");
    expect(deriveTargetTypeFromSource({ id: "fld2", name: "查找", type: "lookup" })).toBeUndefined();
  });

  it("does not clear target values when source is empty in overwrite mode", () => {
    const plan = buildRefreshPlan({
      records: [{ recordId: "rec1", sourceValue: "", targetValue: "保留" }],
      targetFieldId: "fldTarget",
      targetType: "text",
      strategy: "overwrite",
      allowCreateOptions: true
    });

    expect(plan.updateCount).toBe(0);
    expect(plan.skipCount).toBe(1);
    expect(plan.rows[0]?.reason).toBe("来源为空");
  });

  it("skips existing values in fill-empty mode", () => {
    const plan = buildRefreshPlan({
      records: [{ recordId: "rec1", sourceValue: "新值", targetValue: "旧值" }],
      targetFieldId: "fldTarget",
      targetType: "text",
      strategy: "fillEmpty",
      allowCreateOptions: true
    });

    expect(plan.updateCount).toBe(0);
    expect(plan.rows[0]?.reason).toBe("目标已有值");
  });

  it("does not write unchanged values in overwrite mode", () => {
    const plan = buildRefreshPlan({
      records: [{ recordId: "rec1", sourceValue: 42, targetValue: 42 }],
      targetFieldId: "fldTarget",
      targetType: "number",
      strategy: "overwrite",
      allowCreateOptions: true
    });

    expect(plan.updateCount).toBe(0);
    expect(plan.sameCount).toBe(1);
  });

  it("plans missing select options only when option creation is allowed", () => {
    const manualPlan = buildRefreshPlan({
      records: [{ recordId: "rec1", sourceValue: "待处理", targetValue: "" }],
      targetFieldId: "fldStatus",
      targetType: "singleSelect",
      targetOptions: [{ name: "进行中" }],
      strategy: "fillEmpty",
      allowCreateOptions: true
    });

    expect(manualPlan.updateCount).toBe(1);
    expect(manualPlan.optionCreationPlan[0]?.optionNames).toEqual(["待处理"]);

    const autoPlan = buildRefreshPlan({
      records: [{ recordId: "rec1", sourceValue: "待处理", targetValue: "" }],
      targetFieldId: "fldStatus",
      targetType: "singleSelect",
      targetOptions: [{ name: "进行中" }],
      strategy: "fillEmpty",
      allowCreateOptions: false
    });

    expect(autoPlan.updateCount).toBe(0);
    expect(autoPlan.rows[0]?.reason).toBe("目标字段缺少选项");
  });

  it("allows lookup multi-values only for multi-select targets", () => {
    const multiSelectPlan = buildRefreshPlan({
      records: [{ recordId: "rec1", sourceValue: ["华东", "重点"], targetValue: [] }],
      targetFieldId: "fldTags",
      targetType: "multiSelect",
      targetOptions: [],
      strategy: "fillEmpty",
      allowCreateOptions: true
    });

    expect(multiSelectPlan.updateCount).toBe(1);
    expect(multiSelectPlan.optionCreationPlan[0]?.optionNames).toEqual(["华东", "重点"]);

    const textPlan = buildRefreshPlan({
      records: [{ recordId: "rec1", sourceValue: ["华东", "重点"], targetValue: "" }],
      targetFieldId: "fldText",
      targetType: "text",
      strategy: "fillEmpty",
      allowCreateOptions: true
    });

    expect(textPlan.updateCount).toBe(0);
    expect(textPlan.rows[0]?.reason).toBe("多值不能写入该目标类型");
  });

  it("builds batched field update payloads from refresh plan rows", () => {
    const plan = buildRefreshPlan({
      records: [
        { recordId: "rec1", sourceValue: "A", targetValue: "" },
        { recordId: "rec2", sourceValue: "B", targetValue: "B" }
      ],
      targetFieldId: "fldTarget",
      targetType: "text",
      strategy: "overwrite",
      allowCreateOptions: true
    });

    expect(buildRecordUpdates(plan, "fldTarget")).toEqual([{ recordId: "rec1", fields: { fldTarget: "A" } }]);
  });
});
