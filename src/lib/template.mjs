export const PLACEHOLDER_PATTERN =
  /\{(workspace|root|file|relFile|dir|relDir|config|configDir|name)\}/g;

export const FILES_PLACEHOLDER = '{files}';

export function applyTemplate(input, values) {
  return input.replace(PLACEHOLDER_PATTERN, (_match, key) => values[key] ?? '');
}

export function applyTemplateArray(inputs, values) {
  return (inputs ?? []).map((input) => applyTemplate(input, values));
}

export function applyTemplateRecord(inputs, values) {
  if (!inputs) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(inputs)) {
    out[key] = applyTemplate(value, values);
  }
  return out;
}

export function validateAuditCommandForBatching(command) {
  const hasFiles = (command.args ?? []).some((arg) => arg === FILES_PLACEHOLDER);
  if (!hasFiles) return null;
  const perFilePattern = /\{(file|relFile|dir|relDir)\}/;
  const allParts = [command.cmd, ...(command.args ?? []), command.cwd ?? ''];
  for (const part of allParts) {
    if (typeof part === 'string' && perFilePattern.test(part)) {
      return 'audit command uses {files} alongside per-file placeholders {file}, {relFile}, {dir}, or {relDir}';
    }
  }
  return null;
}
