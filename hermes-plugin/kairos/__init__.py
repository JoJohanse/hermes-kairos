"""KAIROS — proactive conversation engine plugin for hermes.

Decides *when* the agent should reach out first. This directory is a native
hermes directory-plugin: ``plugin.yaml`` + an ``__init__.py`` exposing
``register(ctx)``. The actual logic lives in :mod:`bridge` (stdlib-only and
hermes-free so it unit-tests in isolation).

Install::

    cp -r hermes-plugin/kairos ~/.hermes/plugins/kairos

The plugin spawns the kairos sidecar (``node <repo>/dist/hermes-bridge/main.js``),
forwards conversation activity to it via hermes hooks, and listens on
``127.0.0.1:<callbackPort>/speak`` for the sidecar's proactive decisions. See
``README.md`` for the full setup and delivery modes.
"""

from __future__ import annotations

# Relative import works when hermes loads this directory as ``hermes_plugins.<slug>``;
# the bare fallback keeps the module importable when loaded outside a package.
try:  # pragma: no cover - exercised by hermes' loader
    from .bridge import register
except ImportError:  # pragma: no cover - direct-path import fallback
    from bridge import register  # type: ignore[no-redef]

__all__ = ["register"]
