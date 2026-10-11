import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { mcpInput } from "./mcpInput.ts";
import {
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpUpdateScheduledTaskInput,
} from "./orchestratorMcp.ts";
import { ProjectUpdatePayload } from "./project.ts";

describe("mcpInput", () => {
  it("omits null optional keys recursively without changing the source contract or declaration", () => {
    const original = Schema.Struct({
      target: Schema.optional(Schema.Struct({ model: Schema.optional(Schema.String) })),
      rows: Schema.Array(Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
      clear: Schema.optional(Schema.NullOr(Schema.String)),
      exact: Schema.optionalKey(Schema.String),
    });
    const adapted = mcpInput(original);
    const decode = Schema.decodeUnknownSync(adapted);
    expect(
      decode({ target: { model: null }, rows: [{ enabled: null }], clear: null }),
    ).toStrictEqual({ target: {}, rows: [{}], clear: null });
    expect(decode({ rows: [], target: null })).toStrictEqual({ rows: [] });
    expect(decode({ rows: [], target: undefined })).toStrictEqual({ rows: [], target: undefined });
    expect(() => decode({ rows: [], exact: null })).toThrow();
    expect(() => Schema.decodeUnknownSync(original)({ rows: [], target: null })).toThrow();
    expect(Schema.toJsonSchemaDocument(adapted)).toEqual(Schema.toJsonSchemaDocument(original));
  });

  it("preserves checks, false and zero, and rejects required nulls", () => {
    const decode = Schema.decodeUnknownSync(
      mcpInput(
        Schema.Struct({
          required: Schema.String,
          limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
          enabled: Schema.optional(Schema.Boolean),
        }),
      ),
    );
    expect(decode({ required: "x", limit: 0, enabled: false })).toStrictEqual({
      required: "x",
      limit: 0,
      enabled: false,
    });
    expect(() => decode({ required: null })).toThrow();
    expect(() => decode({ required: "x", limit: -1 })).toThrow();
    expect(() => decode({ required: "x", enabled: "false" })).toThrow();
  });

  it("preserves transformed canonical and shorthand model options", () => {
    const decode = Schema.decodeUnknownSync(mcpInput(OrchestratorMcpDelegateTaskInput));
    expect(
      decode({ task: "Inspect", target: { model: null, options: { reasoning: "high" } } }),
    ).toStrictEqual({ task: "Inspect", target: { options: [{ id: "reasoning", value: "high" }] } });
    expect(
      decode({ task: "Inspect", target: { options: [{ id: "reasoning", value: "high" }] } }).target
        ?.options,
    ).toEqual([{ id: "reasoning", value: "high" }]);
  });

  it("keeps semantic nulls in project patches and webhook schedules", () => {
    const project = {
      defaultModelSelection: null,
      projectIcon: null,
      faviconPath: null,
      defaultThreadEnvMode: null,
    };
    expect(Schema.decodeUnknownSync(mcpInput(ProjectUpdatePayload))(project)).toStrictEqual(
      project,
    );
    const decode = Schema.decodeUnknownSync(mcpInput(OrchestratorMcpUpdateScheduledTaskInput));
    const input = {
      scheduledTaskId: "task-1",
      schedule: { type: "webhook", signature: null, maxDeliveryAgeMinutes: null },
    };
    expect(decode(input)).toStrictEqual(input);
    expect(
      decode({
        scheduledTaskId: "task-1",
        schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: null },
      }),
    ).toStrictEqual({
      scheduledTaskId: "task-1",
      schedule: { type: "fixed_time", timeOfDay: "09:00" },
    });
  });
});
