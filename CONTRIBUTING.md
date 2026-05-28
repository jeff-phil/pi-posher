# Contributing to pi-posher

Thank you for considering a contribution! This project welcomes issues and pull requests.

## How to contribute

1. **Open an issue** first for bugs or feature requests at the GitHub repository.

2. **Fork the repo** and create a feature branch.

3. **Run the test suite** before submitting:

   ```bash
   npm test
   ```

4. **Ensure linting passes**:

   ```bash
   npm run lint
   ```

5. **Verify formatting**:

   ```bash
   npm run format
   ```

6. **Open a pull request** with a clear description of the change.

## Development notes

- Tests use Node's built-in test runner (`node:test`).
- Add tests for any new behavior in `test/`.
- Keep the bundled `poshifiers.json.default` in sync with documentation.
- The code-embedded fallback (`DEFAULT_POSHIFIERS`) is a last-resort stub used only when the bundled `poshifiers.json.default` is missing. The seed file and bundled defaults are the source of truth; keep them in sync with documentation.

## Code style

- Prettier and ESLint configs are included.
- Import order is enforced via `eslint-plugin-simple-import-sort`.
- Run `npm run format` and `npm run lint` before committing.
