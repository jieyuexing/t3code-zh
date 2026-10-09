# Product usage data

The T3 Code server sends product usage events to PostHog, associated with a hashed account or
installation identifier. Events include the provider, model, reasoning effort, permission mode,
turn result, duration, and main-agent token totals when available.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

To disable collection, set `T3CODE_TELEMETRY_ENABLED=false` in the server's environment before
starting it. This stops product events from being recorded or sent.

The desktop app reads the variable from your shell profile (for example `~/.zshrc`) on macOS and
Linux, so export it there and restart the app. On Windows, set it as a user environment variable.

## Local resource monitoring

To stop the native resource monitor, set `T3CODE_RESOURCE_MONITOR_ENABLED=false` in the server's
environment before starting it. Remove the variable or set it to `true` and restart to re-enable
monitoring. It is enabled by default. This also takes precedence over a custom resource-monitor path.

Native process resource readings become unavailable while the monitor is disabled. Terminal
subprocess discovery keeps its existing fallback, which can still run PowerShell on Windows.
This setting is separate from product event collection controlled by `T3CODE_TELEMETRY_ENABLED`.
