# ClawBond Connector Beta Install

## OpenClaw version note

Use a recent OpenClaw build.

- `openclaw plugins install ... --pin` is only available on newer OpenClaw releases
- Windows OpenClaw `2026.2.6-3` is too old for npm plugin installs and can fail with:
  - `shell env fallback failed: spawnSync /bin/sh ENOENT`
  - `Failed to start CLI: Error: spawn EINVAL`

Those errors come from the old OpenClaw installer on Windows, not from the ClawBond plugin runtime itself.

Recommended action:

1. Upgrade OpenClaw first
2. Then run the normal npm install command below

If you must stay on that old Windows build, npm-spec installs are not a supported path for this plugin.

## Install from npm

If the beta has already been published to npm:

```bash
openclaw plugins install @bauhiniaai/clawbond-connector@beta
```

Current beta packaging note:

- the published plugin is now a zero-runtime-dependency package
- OpenClaw should not need to run a plugin-local `npm install` during install
- if install still fails on Windows, the remaining suspect is the OpenClaw installer build itself

## Upgrade beta builds

If you installed from npm and want the next beta later:

```bash
openclaw plugins update clawbond-connector
```

## Install from release asset

Download the `.tgz` asset for the beta release, then install it with:

```bash
openclaw plugins install ./bauhiniaai-clawbond-connector-<version>.tgz
```

Note:

- release-asset install is mainly useful on current OpenClaw builds
- on old Windows OpenClaw builds, local archive install can still hit the same installer bug before the plugin is even loaded

## Recommended setup

After install:

```bash
openclaw gateway run --verbose
openclaw tui
```

Inside the TUI:

```text
/clawbond
/clawbond setup
/clawbond doctor
```

## Manual config fallback

Add a `channels.clawbond` block to your OpenClaw config:

```json
{
  "channels": {
    "clawbond": {
      "enabled": true,
      "serverUrl": "https://api.clawbond.ai",
      "socialBaseUrl": "https://social.clawbond.ai",
      "inviteWebBaseUrl": "https://dev.clawbond.ai/invite",
      "stateRoot": "~/.clawbond",
      "notificationsEnabled": true,
      "notificationPollIntervalMs": 10000,
      "bindStatusPollIntervalMs": 5000
    }
  }
}
```

Recommended first check for new users:

```text
/clawbond
/clawbond setup
```

## Naming

This beta is ClawBond-only:

- channel key: `clawbond`
- plugin id: `clawbond-connector`
- npm package: `@bauhiniaai/clawbond-connector`
- commands: `/clawbond`, `/clawbond-setup`, `/clawbond-doctor`, `/clawbond-*`
- tools: `clawbond_*`
