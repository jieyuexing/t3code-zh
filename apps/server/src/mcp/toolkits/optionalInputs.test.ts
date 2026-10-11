import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Tool, Toolkit } from "effect/ai";
import { PreviewToolkit } from "./preview/tools.ts";
import { WorktreeToolkit } from "./worktree/tools.ts";
import { ThreadToolkit } from "./thread/tools.ts";
import { AttachmentToolkit } from "./attachment/tools.ts";
import { ProjectToolkit } from "./project/tools.ts";
import { EnvironmentToolkit } from "./environment/tools.ts";
import { PreviewControlsToolkit } from "./previewControls/tools.ts";
import { DeviceToolkit } from "./device/tools.ts";
import { PullRequestsToolkit } from "./pullRequests/tools.ts";
import { HtmlToolkit } from "./html/tools.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { OrchestratorToolkit } from "./orchestrator/tools.ts";

const cases = [
  ["t3_thread_list", {}, "settled", false, "false"],
  ["t3_thread_read", { threadId: "thread-1" }, "afterPosition", 2, "2"],
  ["t3_thread_read", { threadId: "thread-1" }, "view", "activity", "invalid"],
  ["delegate_task", { task: "Inspect" }, "title", "Review", 12],
  ["update_scheduled_task", { scheduledTaskId: "task-1" }, "enabled", false, "false"],
] as const;

describe("optional MCP inputs", () => {
  it.each(cases)("%s.%s treats null as omission", (name, input, key) => {
    const decode = Schema.decodeUnknownSync(OrchestratorToolkit.tools[name].parametersSchema);
    expect(decode({ ...input, [key]: null })).toStrictEqual(decode(input));
  });
  it.each(cases)(
    "%s.%s preserves valid values and rejects wrong types",
    (name, input, key, valid, invalid) => {
      const decode = Schema.decodeUnknownSync(OrchestratorToolkit.tools[name].parametersSchema);
      expect(decode({ ...input, [key]: valid })).toHaveProperty(key, valid);
      expect(() => decode({ ...input, [key]: invalid })).toThrow();
    },
  );
  it("delegate_task.target.model treats null as omission", () => {
    const decode = Schema.decodeUnknownSync(
      OrchestratorToolkit.tools.delegate_task.parametersSchema,
    );
    expect(decode({ task: "Inspect", target: { model: null } })).toStrictEqual(
      decode({ task: "Inspect", target: {} }),
    );
    expect(decode({ task: "Inspect", target: { model: "model-1" } }).target?.model).toBe("model-1");
    expect(() => decode({ task: "Inspect", target: { model: 12 } })).toThrow();
  });
});

interface InputProperty {
  readonly type?: string;
  readonly anyOf?: readonly InputProperty[];
}
const allowsNull = (schema: InputProperty): boolean =>
  schema.type === "null" || schema.anyOf?.some(allowsNull) === true;

const fixtures: Record<string, Record<string, unknown>> = {
  orchestrator_capabilities: {},
  delegate_task: {
    task: "value",
  },
  task_status: {
    taskId: "value",
  },
  task_cancel: {
    taskId: "value",
  },
  t3_workflow_stop: {
    threadId: "value",
    subagentId: "value",
  },
  schedule_task: {
    prompt: "value",
    schedule: {
      type: "interval",
      everyMs: 60000,
    },
  },
  list_scheduled_tasks: {},
  update_scheduled_task: {
    scheduledTaskId: "value",
  },
  delete_scheduled_task: {
    scheduledTaskId: "value",
  },
  request_secret: {
    label: "value",
    reason: "value",
  },
  create_threads: {
    threads: [{}],
  },
  t3_thread_list: {},
  t3_thread_read: {
    threadId: "value",
  },
  t3_thread_update: {
    action: "regenerate_title",
  },
  t3_thread_send: {
    threadId: "value",
    message: "value",
  },
  t3_thread_wait: {
    threadId: "value",
  },
  t3_thread_interrupt: {
    threadId: "value",
  },
  preview_dialog: {
    accept: false,
  },
  preview_status: {},
  preview_open: {},
  preview_navigate: { url: "https://example.com" },
  preview_resize: {
    mode: "fill",
  },
  preview_set_appearance: {
    colorScheme: "system",
  },
  preview_snapshot: {},
  preview_click: { locator: "button" },
  preview_type: {
    text: "value",
  },
  preview_hover: { locator: "button" },
  preview_select: { locator: "select", values: [] },
  preview_drag: {
    source: "value",
    target: "value",
  },
  preview_upload: {
    paths: [],
  },
  preview_press: {
    key: "value",
  },
  preview_scroll: { deltaY: 1 },
  preview_evaluate: {
    expression: "value",
  },
  preview_wait_for: { selector: "body" },
  preview_recording_start: {},
  preview_recording_stop: {},
  t3_worktree_handoff: {
    branch: "value",
  },
  t3_worktree_status: {},
  t3_worktree_list: {},
  run_scheduled_task_now: {
    taskId: "value",
  },
  t3_thread_search: {
    query: "value",
  },
  t3_thread_fork: {
    sourcePoint: {
      type: "latest_stable",
    },
  },
  t3_thread_merge_back: {
    targetThreadId: "value",
    sourcePoint: {
      type: "latest_stable",
    },
  },
  t3_thread_transfers: {},
  t3_thread_configuration: {},
  t3_thread_configure: {
    modelSelection: {
      instanceId: "codex",
      model: "model-1",
    },
  },
  t3_pending_request_list: {},
  t3_pending_request_read: {
    requestId: "value",
  },
  t3_pending_request_respond: {
    requestId: "value",
    answers: {},
  },
  t3_thread_organize: {
    action: "pin",
  },
  t3_queue_list: {},
  t3_queue_read: {
    queuedRunId: "value",
  },
  t3_queue_edit: {
    queuedRunId: "value",
    text: "value",
  },
  t3_queue_cancel: {
    queuedRunId: "value",
  },
  t3_queue_reorder: {
    queuedRunId: "value",
    beforeRunId: "value",
  },
  t3_queue_promote_to_steer: {
    queuedRunId: "value",
    targetRunId: "value",
  },
  t3_attachment_prepare_upload: {
    upload: {
      name: "value",
      mimeType: "image/gif",
      sizeBytes: 1,
    },
  },
  t3_attachment_discard: {
    attachmentId: "value",
  },
  t3_thread_send_attachments: {
    attachments: [
      {
        type: "image",
        id: "value",
        name: "value",
        mimeType: "image/png",
        sizeBytes: 1,
      },
    ],
  },
  t3_thread_launch: {
    title: "value",
  },
  t3_project_list: {},
  t3_project_read: {
    projectId: "value",
  },
  t3_project_create: {
    title: "value",
  },
  t3_project_update: {
    projectId: "value",
  },
  t3_project_delete: {
    projectId: "value",
  },
  t3_project_clone: {
    destinationPath: "value",
  },
  t3_environment_read: {},
  t3_environment_preferences_update: {},
  t3_preview_list: {},
  t3_preview_close: {
    tabId: "value",
  },
  device_list: {},
  device_open: {},
  device_screenshot: {},
  device_close: {},
  link_pull_request: {},
  unlink_pull_request: {},
  list_thread_pull_requests: {},
  watch_pull_request: {},
  unwatch_pull_request: {},
  html_preview: {
    html: "value",
  },
  html_render: {
    html: "value",
    title: "value",
    height: 240,
  },
};

const toolkits = [
  OrchestratorToolkit,
  PreviewToolkit,
  WorktreeToolkit,
  ThreadToolkit,
  AttachmentToolkit,
  ProjectToolkit,
  EnvironmentToolkit,
  PreviewControlsToolkit,
  DeviceToolkit,
  PullRequestsToolkit,
  HtmlToolkit,
];

describe("advertised optional null parameters", () => {
  it.each(toolkits.flatMap((toolkit) => Object.values(toolkit.tools)))("$name", (tool) => {
    const decode = Schema.decodeUnknownSync(tool.parametersSchema);
    const fixture = fixtures[tool.name];
    expect(fixture).toBeDefined();
    decode(fixture);
    const json = Tool.getJsonSchema(tool) as {
      properties?: Record<string, InputProperty>;
      required?: readonly string[];
    };
    for (const [key, property] of Object.entries(json.properties ?? {})) {
      if (!json.required?.includes(key) && allowsNull(property)) {
        const input = { ...fixture };
        if (key in input) {
          delete input[key];
          if (tool.name === "preview_navigate")
            input.target = { kind: "url", url: "https://example.com" };
          else if (tool.name === "preview_scroll") input.deltaX = 1;
          else if (tool.name === "preview_wait_for") input.text = "ready";
          else input.selector = "button";
        }
        decode(input);
        expect(() => decode({ ...input, [key]: null }), `${tool.name}.${key}`).not.toThrow();
      }
    }
  });
});

const probeToolkit = Toolkit.make(
  Tool.make("optional_input_probe", {
    parameters: OrchestratorToolkit.tools.t3_thread_list.parametersSchema,
    success: Schema.Boolean,
  }),
);
it.effect("Toolkit.handle decodes explicit null before invoking the handler", () =>
  Effect.gen(function* () {
    const toolkit = yield* probeToolkit;
    for (const input of [{}, { settled: null }]) {
      const results = yield* toolkit
        .handle("optional_input_probe", input)
        .pipe(Effect.flatMap(Stream.runCollect));
      expect(results[0]).toMatchObject({ result: true, isFailure: false });
    }
  }).pipe(
    Effect.provide(
      probeToolkit.toLayer({
        optional_input_probe: (input) =>
          Effect.succeed(input.settled === undefined && !Object.hasOwn(input, "settled")),
      }),
    ),
  ),
);

it("accepts nested optional nulls in schedule, launch, browser and attachment inputs", () => {
  const inputs = [
    [
      OrchestratorToolkit.tools.schedule_task,
      {
        prompt: "Inspect",
        schedule: {
          type: "webhook",
          signature: {
            header: "x-signature",
            encoding: "hex",
            prefix: "",
            secret: null,
            secretRef: null,
          },
        },
      },
    ],
    [
      OrchestratorToolkit.tools.create_threads,
      { threads: [{ title: null, target: { model: null, providerInstanceId: null } }] },
    ],
    [
      PreviewToolkit.tools.preview_navigate,
      { target: { kind: "environment-port", port: 5173, protocol: null, path: null } },
    ],
    [
      ProjectToolkit.tools.t3_project_update,
      {
        projectId: "project-1",
        scripts: [
          {
            id: "script-1",
            name: "test",
            command: "echo test",
            icon: "play",
            runOnWorktreeCreate: false,
            runOnSettle: null,
            async: null,
            previewUrl: null,
            autoOpenPreview: null,
          },
        ],
      },
    ],
    [
      AttachmentToolkit.tools.t3_thread_send_attachments,
      {
        attachments: [
          {
            type: "file",
            id: "file-1",
            name: "test.txt",
            mimeType: "text/plain",
            sizeBytes: 1,
            source: null,
          },
        ],
      },
    ],
  ] as const;
  for (const [tool, input] of inputs) {
    const decode = Schema.decodeUnknownSync(tool.parametersSchema);
    expect(() => decode(input), tool.name).not.toThrow();
  }
});
