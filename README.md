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
      ]
    }
  ]
}
```

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

```
 /poshify (file|dir)          # Run configured tools for file or directory
 /poshify --init              # Install default configs and dependencies
 /poshify --fix [file|dir]    # Run ESLint --fix
 /poshify --help              # Show this usage
```

`/poshify` with no arguments shows help message.

**`/poshify --init`** copies default config files in `$PI_CODING_AGENT_DIR/extensions/pi-posher/default-configs/` directory (`eslint.config.mjs`, `.prettierrc`, `.prettierignore`) into the current project and runs `npm install --save-dev eslint @eslint/js globals eslint-config-prettier` to install/update the required ESLint and Prettier packages. It skips any files that already exist.  **Note:** This is just a helper, you can add your necessary formatter, linter, etc. configuration files and install necessary tools without ever doing a `poshify --init`.

**`/poshify --fix`** runs `npx eslint --fix` on the target path. It requires an `eslint.config.*` file to exist in the current working directory. Again, not necessary to run, just a quick helper. In the future, fix will become file specific defined in the configuration file.

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
|---|---|---|
| `{workspace}` | Pi working directory, or directory containing `.pi/poshifiers.json` | `/Users/jeffrey/my-project` |
| `{root}` | Nearest directory containing an `anchor` marker | `/Users/jeffrey/my-project` |
| `{file}` | Absolute path to the file being processed | `/Users/jeffrey/my-project/src/foo.go` |
| `{relFile}` | `{file}` relative to `{root}` | `src/foo.go` |
| `{dir}` | Absolute directory containing the file | `/Users/jeffrey/my-project/src` |
| `{relDir}` | That directory relative to `{root}` | `src` |
| `{config}` | Resolved command config path (if set) | |
| `{configDir}` | Directory containing `{config}` | |

`{root}` is found by walking up from `{file}` looking for `anchors`. `{workspace}` is where Pi is running. They are usually the same, but in a monorepo where a file is in `packages/bar/` and the anchor (`package.json`) is there, `{root}` = `packages/bar/` while `{workspace}` = the repo root.

## Output examples

```text
 Poshify:

 ✅ markdown: /pi-agent/npm-global/bin/prettier checked README.md
 ✅ typescript: /pi-agent/npm-global/bin/prettier checked extensions/pi-posher/pi-posher.mjs
 ✅ typescript: /pi-agent/npm-global/bin/eslint checked extensions/pi-posher/pi-posher.mjs
 ✅ json: /pi-agent/npm-global/bin/prettier modified package.json
```

```text
 Poshify:

 ✅ typescript: /pi-agent/npm-global/bin/prettier checked extensions/pi-posher/pi-posher.mjs
 ⚠️ typescript /pi-agent/npm-global/bin/eslint failed with exit code 1:
 /Users/jeffrey/devel/pi/pi-posher/extensions/pi-posher/pi-posher.mjs
   1:1  error  Run autofix to sort these imports!  simple-import-sort/imports

 ✖ 1 problem (1 error, 0 warnings)
   1 error and 0 warnings potentially fixable with the `--fix` option.
```

```text
 Poshify:

 ✅ ESLint --fix completed with no issues.
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
