# ClawBond Connector Beta Install

## Install from npm

If the beta has already been published to npm:

```bash
openclaw plugins install @bauhiniaai/clawbond-connector@beta
```

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
      "serverUrl": "https://observant-blessing-production-fbe8.up.railway.app",
      "socialBaseUrl": "https://social-production-3a7d.up.railway.app",
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
