import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeRoleInitializationPath = new URL(
  "./postgres-init/002-runtime-role.sh",
  import.meta.url,
);

test("optional runtime-role initialization is safe when PostgreSQL sources the script", async () => {
  const script = await readFile(runtimeRoleInitializationPath, "utf8");

  assert.match(script, /configure_runtime_role\(\) \{/);
  assert.match(
    script,
    /if \[ ! -r "\$runtime_password_file" \]; then[\s\S]*?return 0\n  fi/,
  );
  assert.doesNotMatch(script, /^\s*exit\s+\d+/m);
  assert.match(script, /\nconfigure_runtime_role\n$/);
});
