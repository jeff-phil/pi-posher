# pi-posher

Pi extension that automatically runs tools such as, formatters, linters, SAST, file conversions, etc. after successful `write` / `edit` agent tool calls.

Users are also able to run `/poshify` slash command on-demand to validate changes to files made outside Pi, or for adding external files into a project that need to be posh.

## Why

Many times IDE's automatically will format, lint, reorganize imports, do security checks, convert files, and run many other tools when saving files. This allows users to immediately know issues and make corrections when it's fresh, vs. going through an entire pipeline.

Agents need the same capabilities in order to format, adjust, check files after edits and write operations.

## Install

```bash
pi install npm:pi-posher
```

## Configuration

Global config, trusted automatically:

```text
~/.pi/agent/extensions/pi-posher/poshifiers.json
```

**On first use**, the extension seeds this file with default poshifiers for go, python, typescript, json, yaml, and markdown. You can edit or remove any entry.

Project-local config, requires trust:

```text
~/projects/my-project/.pi/poshifiers.json
```

Project entries override global entries with the same `name` (go, typescript, python, etc.).

## Trust and security

Project local configs could run arbitrary commands on your machine that are evil in nature.

Here are the guardrails to prevent malicious configs and scripts:

- Project local config content is uniquely hashed
- Unknown hashes prompt for `Trust once`, `Trust always`, or `Reject`
- The prompt shows every configured tool command in the project local config file
- `Trust always` stores the hash in `~/.pi/agent/extensions/pi-posher/trust/poshifiers.json`
- Changing the config changes the hash and asks again to trust or reject
- Non-interactive mode rejects project local config by default
- Commands run as `cmd` & `args[]`, so each can be validated against shell injection

Global config is considered trusted because it is user-owned agent configuration.

## Example config

```json
{
  "poshifiers": [
    {
      "name": "go",
      "include": ["**/*.go"],
      "exclude": ["vendor/**"],
      "anchors": ["go.mod"],
      "tools": [
        {
          "cmd": "gofmt",
          "args": ["-w", "{file}"],
          "cwd": "{root}",
          "timeoutMs": 25000
        },
        {
          "cmd": "golangci-lint",
          "args": ["run", "--new-from-rev=HEAD", "--timeout=25s", "./{relDir}"],
          "cwd": "{root}",
          "timeoutMs": 30000
        }
      ]
    },
    {
      "name": "python",
      "include": ["**/*.py"],
      "anchors": ["pyproject.toml", "ruff.toml"],
      "tools": [
        {
          "cmd": "uv",
          "args": ["run", "ruff", "format", "{file}"],
          "cwd": "{root}",
          "timeoutMs": 25000
        },
        {
          "cmd": "uv",
          "args": ["run", "ruff", "check", "{file}"],
          "cwd": "{root}",
          "timeoutMs": 30000
        }
      ]
    },
    {
      "name": "typescript",
      "include": ["**/*.{ts,tsx,js,jsx,mjs,cjs,svelte}"],
      "exclude": [
        "node_modules/**",
        "dist/**",
        ".next/**",
        ".svelte-kit/**",
        "build/**"
      ],
      "anchors": ["package.json"],
      "init-setup": {
        "init-configs": [".prettierrc", ".prettierignore", "eslint.config.mjs", "eslint-ts.mjs"],
        "init-tools": [
          {
            "cmd": "npm",
            "args": ["install", "--save-dev", "prettier", "eslint", "@eslint/js", "globals", "eslint-config-prettier", "eslint-plugin-simple-import-sort", "eslint-plugin-unused-imports", "typescript-eslint"],
            "cwd": "{root}",
            "timeoutMs": 120000
          }
        ]
      },
      "maxFileSizeBytes": 2097152,
      "tools": [
        {
          "cmd": "prettier",
          "args": ["--write", "{file}"],
          "cwd": "{root}",
          "timeoutMs": 25000
        },
        {
          "cmd": "eslint",
          "args": ["{file}"],
          "cwd": "{root}",
          "timeoutMs": 30000
        }
      ],
      "fix-tools": [
        {
          "cmd": "eslint",
          "args": ["--fix", "{file}"],
          "cwd": "{root}",
          "timeoutMs": 120000
        }
      ]
    }
  ]
}
```

Each poshifier has an optional `init-setup` block with:

- `init-configs`: Array of bundled config files, directories, or glob patterns to copy into the project root (`{root}`). Supports `{name}` placeholder for per-language variants.
  - Paths without `{name}/` are copied to `{root}` directly (e.g., `.prettierrc`).
  - Paths with `{name}/` strip the `{name}` prefix and preserve any remaining subdirectories (e.g., `{name}/foo/bar.json` → `{root}/foo/bar.json`).
  - Directory entries (e.g., `{name}/foo/`, `{name}/foo/**`) are copied recursively. Existing files in the destination are skipped; new files from the source are merged in.
  - Glob patterns are supported in the final path segment (e.g., `{name}/configs/*.json`, `{name}/rules/*.{json,yaml}`). The glob matches files in the directory part. Any matched file is copied with its parent subdirectory preserved.
  - Files already in the destination are skipped without error.
  - Empty glob matches silently skip.
- `init-tools`: Commands to run during init (e.g., `npm install --save-dev ...`).
- `fix-tools`: Commands to run for `/poshify --fix` (same schema as `tools`).
- `maxFileSizeBytes`: Optional limit in bytes; files larger than this are silently skipped (default 2 MB).

Every tool object (in `tools`, `fix-tools`, or `init-tools`) supports these fields:

| Field | Type | Description |
| --- | --- | --- |
| `cmd` | string | Command to run |
| `args` | string[] | Arguments passed to the command |
| `cwd` | string | Working directory (supports placeholders) |
| `timeoutMs` | number | Timeout in milliseconds (default 15000) |
| `config` | string | Path to a config file; sets `{config}` and `{configDir}` placeholders |
| `env` | object | Key/value map merged into the command's environment |

## Behavior

After the agent successfully does a `write` or `edit` operation:

1. Extension looks for poshifiers matching `include` / `exclude` file and directory glob patterns
2. Extension uses `anchors` to find the `{root}`
3. Skips files above `maxFileSizeBytes`
4. Runs each command in the `tools` array sequentially, in order.
5. Appends a compact summary to the original tool result, or error details if fails.

Summaries that contain issues are also sent as a user-visible, tool-styled diagnostic notice.

### Manually running

You can also trigger poshify manually with the slash command or the `run_poshify` custom tool.

#### `/poshify` slash command

```text
 /poshify (file|dir)          # Run configured tools for file or directory
 /poshify --init <name>       # Install init configs for a poshifier type
 /poshify --fix [file|dir]    # Run configured fix-tools
 /poshify --help              # Show this usage
```

`/poshify` with no arguments shows help message, including the list of available `--init` names.

**`/poshify --init <name>`** copies the `init-configs` defined for that poshifier into the current project, seeds user-level overrides from bundled templates if absent, and runs the `init-tools` commands (typically `npm install --save-dev ...`). Existing files in the project are skipped. For example:

- `/poshify --init typescript` copies `.prettierrc`, `.prettierignore`, `eslint.config.mjs`, `eslint-ts.mjs` to the project root and installs ESLint + Prettier.
- `/poshify --init markdown` copies `.prettierrc` to the project root and `.markdownlint.json` (bundled at `{name}/.markdownlint.json`) to the project root, then installs Prettier + markdownlint-cli.
- A config like `{name}/foo/bar.json` would be placed at `foo/bar.json` in the project.

**`/poshify --fix [file|dir]`** runs the `fix-tools` configured for each matching poshifier. Each poshifier can define its own fix commands (e.g., `eslint --fix`, `ruff check --fix`, `markdownlint --fix`). Files without configured `fix-tools` are silently skipped.

#### `run_poshify` tool

Callable by the LLM with a `path` argument. The model can invoke it when asked to "run poshify on X".

Both the slash command and the tool scan matching files recursively, run configured tools, and report results in the same output format as the automatic trigger.

## Relative paths and placeholders

Path rules:

1. Absolute paths are used as-is.
2. Relative `cmd`, `config`, and `cwd` values with `/` are resolved relative to `{root}`.
3. Bare command names are resolved through `PATH`.

Placeholders (template tags):

| Placeholder | Meaning | Example |
| --- | --- | --- |
| `{workspace}` | Pi working directory, or directory containing `.pi/poshifiers.json` | `/Users/jeffrey/my-project` |
| `{root}` | Nearest directory containing an `anchor` marker | `/Users/jeffrey/my-project` |
| `{file}` | Absolute path to the file being processed | `/Users/jeffrey/my-project/src/foo.go` |
| `{relFile}` | `{file}` relative to `{root}` | `src/foo.go` |
| `{dir}` | Absolute directory containing the file | `/Users/jeffrey/my-project/src` |
| `{relDir}` | That directory relative to `{root}` | `src` |
| `{config}` | Resolved command config path (if set) | |
| `{configDir}` | Directory containing `{config}` | |
| `{name}` | Poshifier name (useful in `init-setup` paths and args) | `typescript` |

`{root}` is found by walking up from `{file}` looking for `anchors`. `{workspace}` is where Pi is running. They are usually the same, but in a monorepo where a file is in `packages/bar/` and the anchor (`package.json`) is there, `{root}` = `packages/bar/` while `{workspace}` = the repo root.

## Output examples

```text
 Poshify:

 ✅ markdown: /pi-agent/npm-global/bin/prettier checked README.md
 ✅ typescript: /pi-agent/npm-global/bin/prettier checked src/pi-posher.mjs
 ✅ typescript: /pi-agent/npm-global/bin/eslint checked src/pi-posher.mjs
 ✅ json: /pi-agent/npm-global/bin/prettier modified package.json
```

```text
 Poshify:

 ✅ typescript: /pi-agent/npm-global/bin/prettier checked src/pi-posher.mjs
 ⚠️ typescript /pi-agent/npm-global/bin/eslint failed with exit code 1:
 /Users/jeffrey/devel/pi/pi-posher/src/pi-posher.mjs
   1:1  error  Run autofix to sort these imports!  simple-import-sort/imports

 ✖ 1 problem (1 error, 0 warnings)
   1 error and 0 warnings potentially fixable with the `--fix` option.
```

```text
 Poshify:

 ✅ typescript: eslint fixed src/index.ts
```

## Disable a poshifier

Remove it from the config, or override with an empty object:

```json
{
  "poshifiers": [{ "name": "go" }]
}
```

## Acknowledgement

Security aspects inspired by [pi-code-quality](https://pi.dev/packages/pi-code-quality).
