import assert from 'node:assert/strict';

// Accept only this known runtime startup warning; every other diagnostic fails.
// Keep the original bytes visible, including unexpected security warnings.
export function assertOnlyNodeStartupDiagnostics(stderr) {
  if (stderr) process.stderr.write(stderr);
  assert.match(stderr, /^(?:\(node:\d+\) \[UNDICI-EHPA\] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time\.\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?$/);
}
