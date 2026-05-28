# pi-posher Domain Language

## Concepts

- **Poshifier** — A configured language/ecosystem entry with `include`/`exclude` glob patterns, `anchors`, and named command **sections** (`tools`, `fix-tools`, `audit-tools`, `init-tools`).
- **Section** — A named group of commands within a poshifier.
- **Poshify Engine** — The module that orchestrates file matching, section dispatch, and result assembly. Interface: `runPoshify(ctx, options)`.
- **Tool Executor** — The module that validates command executability and runs a single external command. Interface: `execute(command, signal)`.
- **Reporter** — Stateless formatting module that turns structured results into steer-ready strings.
- **Finding** — A structured audit/security result: `{tool, rule, file, line, column, message, severity}`.
- **Batch** — A grouped invocation of an audit command across multiple matched files.
- **Layer** — A config source (defaults, global, project) loaded and merged by name.
