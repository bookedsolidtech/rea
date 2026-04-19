---
'@bookedsolid/rea': minor
---

Registry `env:` values now support `${VAR}` interpolation.

Registry entries can now reference process env vars via `${VAR}` syntax in the explicit `env:` map. Enables token-bearing MCPs (discord-ops, github, etc.) to route through rea-gateway without committing literal tokens to `registry.yaml` and without widening the restrictive `env_passthrough` allowlist. Missing vars fail the affected server at startup (fail-closed); the rest of the gateway still comes up. `env_passthrough` behavior is unchanged.

### Grammar (deliberately minimal)

- Only `${VAR}` — curly-brace form in env **values**. Keys are never interpolated.
- No bare `$VAR` (ambiguous with shell semantics).
- No default syntax (`${VAR:-fallback}`) — kept out of the 0.3.0 surface.
- No command substitution (`$(cmd)`) — never.
- No recursive expansion. If `${FOO}` resolves to a string that itself contains `${BAR}`, the inner text is treated as a literal. This is intentional: a hostile env var's *contents* cannot trigger further lookups.
- Var names follow POSIX identifier rules: `^[A-Za-z_][A-Za-z0-9_]*$`. Empty `${}` or illegal identifier chars are rejected at load time with a clear error.

### Fail-closed on missing vars

If any `${VAR}` referenced by an enabled server is unset at spawn time:

- The affected server is marked unhealthy and skipped by the pool's tool list.
- One stderr line per missing var is emitted with server + var context.
- Every other server with resolved env still starts normally.
- The gateway as a whole does not crash.

### Example

```yaml
# .rea/registry.yaml
version: "1"
servers:
  - name: discord-ops
    command: npx
    args: ['-y', 'discord-ops@latest']
    env:
      BOOKED_DISCORD_BOT_TOKEN: '${BOOKED_DISCORD_BOT_TOKEN}'
      CLARITY_DISCORD_BOT_TOKEN: '${CLARITY_DISCORD_BOT_TOKEN}'
    enabled: true
```

Export the tokens in the same shell that runs `rea serve`:

```bash
export BOOKED_DISCORD_BOT_TOKEN="…"
export CLARITY_DISCORD_BOT_TOKEN="…"
rea serve
```

### Redact-by-default contract

The template in `registry.yaml` is auditable (it commits); the runtime value is not. Env values resolve only inside `buildChildEnv` and pass straight to the child transport — they never flow into `ctx.metadata` or audit records. A new `secretKeys` signal identifies env entries that are secret-bearing (either because the key name matches `/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i` or because a `${VAR}` reference in the value does), so any future telemetry path can make the right call without re-deriving the heuristic.

### Compatibility

- `env_passthrough` semantics unchanged — still refuses secret-looking names at load time. The sanctioned path for secrets is now `env: { NAME: '${ENV_VAR}' }`.
- Existing registries without interpolation continue to work unchanged.
- No new dependencies.
