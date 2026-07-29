"""Sigil memory provider for Hermes Agent.

Bridges Hermes' memory system to a local Sigil install via the `sigil` CLI.
No new network surface is added: the plugin talks to Sigil's single local
daemon through ordinary CLI commands.

Architecture
------------
    prefetch(query)     → `sigil search <q> --namespace=<ns>,default`
    sync_turn(u, a)     → no-op (durable writes require explicit intent)
    is_available()      → shell test: `sigil --help` returns 0
    handle_tool_call()  → explicit search / remember invocations from the model

Shared brain via namespaces
---------------------------
Each Hermes platform writes to its own Sigil namespace:

    cli       → hermes-cli
    telegram  → hermes-telegram
    imessage  → hermes-imessage
    discord   → hermes-discord
    cron      → hermes-cron

Search reads across the platform's own namespace AND `default`. This keeps
Hermes-specific memories easy to inspect while still making ordinary Sigil
memory available to Hermes on the same installation.

Requires
--------
    sigil  CLI on PATH (the local install — `npm install -g @anmol-srv/sigil`
           or wherever the binary is installed)
    ~/.sigil/config.json configured (run `sigil init` once before activating
                         this plugin)
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
from typing import Any, Dict, List

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

# Subprocess timeouts. Search is on the prompt-critical path → tight budget.
# Explicit saves report their real outcome, so allow daemon cold-start headroom.
_SEARCH_TIMEOUT_S = 5
_REMEMBER_TIMEOUT_S = 120
_PREFETCH_LIMIT = 5

# Cap the prefetched context block — Hermes already has a memory_char_limit
# in config.yaml, but we trim early to avoid wasting characters on results
# the agent will never use.
_PREFETCH_CHAR_LIMIT = 2000


def _clean_text(value: Any) -> str:
    """Strip subprocess noise that can break Hermes' tool/result framing."""
    if value is None:
        return ""
    return str(value).replace("\x00", "").strip()


def _ok(payload: Dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _err(message: str) -> str:
    return json.dumps({"error": message}, ensure_ascii=False)


def _sigil_search_args(query: str, namespaces: str, limit: int) -> List[str]:
    return [
        "sigil", "search", query,
        f"--namespace={namespaces}",
        f"--limit={limit}",
    ]


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------

class SigilProvider(MemoryProvider):
    """Hermes memory provider backed by a local Sigil install."""

    def __init__(self) -> None:
        self._session_id: str = ""
        self._platform: str = "cli"
        self._namespace: str = "hermes-cli"
        self._search_namespaces: str = "hermes-cli,default"
        self._hermes_home: str = ""

    @property
    def name(self) -> str:
        return "sigil"

    # -- Lifecycle -----------------------------------------------------------

    def is_available(self) -> bool:
        """Check the sigil CLI is on PATH. No network calls."""
        return shutil.which("sigil") is not None

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        self._session_id = session_id
        self._platform = kwargs.get("platform", "cli")
        self._namespace = f"hermes-{self._platform}"
        # Search this platform's explicit saves plus the local default namespace.
        self._search_namespaces = f"{self._namespace},default"
        self._hermes_home = kwargs.get("hermes_home", "")
        logger.info(
            "Sigil provider initialised: namespace=%s session=%s platform=%s",
            self._namespace, session_id, self._platform,
        )

    def shutdown(self) -> None:
        return None

    # -- Recall (per-turn) ---------------------------------------------------

    def system_prompt_block(self) -> str:
        return (
            "## Memory (Sigil)\n"
            "Persistent local memory shared with the user's other AI tools "
            "(Claude Code, Cursor, Codex CLI, Kiro). Recent relevant facts are "
            f"auto-injected at the top of each turn from namespaces `{self._search_namespaces}`. "
            "Trust the injection — answer from it first.\n\n"
            "Call `sigil_search` ONLY for drill-down questions when the injection "
            "clearly missed something specific. Call `sigil_remember` ONLY when the "
            "user explicitly asks (\"remember that...\", \"save this...\") or clearly "
            "states durable intent. Do not save routine conversation automatically."
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Synchronous recall before the next API call.

        Calls `sigil search` against this platform's namespace plus `default`.
        Returns the raw CLI output as
        context text; Sigil's hybrid search already formats one fact per line
        which is exactly what the system prompt wants.
        """
        if not query or not query.strip():
            return ""

        try:
            result = subprocess.run(
                _sigil_search_args(query, self._search_namespaces, _PREFETCH_LIMIT),
                timeout=_SEARCH_TIMEOUT_S,
                capture_output=True,
                text=True,
                check=False,
            )
        except subprocess.TimeoutExpired:
            logger.warning("sigil search timed out after %ss", _SEARCH_TIMEOUT_S)
            return ""
        except Exception as exc:  # noqa: BLE001 — never break the agent's turn
            logger.warning("sigil search failed: %s", exc)
            return ""

        if result.returncode != 0:
            logger.warning("sigil search exit %s: %s", result.returncode, _clean_text(result.stderr))
            return ""

        out = _clean_text(result.stdout)
        if not out or out == "No results found.":
            return ""

        # Trim early — Hermes also enforces memory_char_limit but truncating
        # here avoids feeding the model results it can't use.
        return out[:_PREFETCH_CHAR_LIMIT]

    # -- Write (per-turn) ----------------------------------------------------

    def sync_turn(self, user_content: str, assistant_content: str, *,
                  session_id: str = "") -> None:
        """Compatibility hook; durable writes require explicit user intent."""
        return None

    # -- Tools (explicit invocation by the model) ----------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [
            {
                "name": "sigil_search",
                "description": (
                    "Search persistent memory across this Hermes platform and the "
                    "installation's default namespace. Use for drill-down when the "
                    "auto-injected context block didn't surface what you need."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Natural-language search query."
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Max results (default 5).",
                            "default": _PREFETCH_LIMIT,
                        },
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "sigil_remember",
                "description": (
                    "Save a single self-contained fact to persistent memory. Use "
                    "ONLY when the user explicitly asks to remember something or "
                    "clearly states durable intent. Do not save routine turns."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "fact": {
                            "type": "string",
                            "description": (
                                "A short, self-contained statement that makes sense "
                                "out of context. Not a conversation summary."
                            )
                        },
                    },
                    "required": ["fact"],
                },
            },
        ]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any]) -> Any:
        if tool_name == "sigil_search":
            return self._tool_search(args)
        if tool_name == "sigil_remember":
            return self._tool_remember(args)
        return _err(f"unknown tool: {tool_name}")

    def _tool_search(self, args: Dict[str, Any]) -> str:
        query = (args.get("query") or "").strip()
        if not query:
            return _err("query is required")
        limit = int(args.get("limit", _PREFETCH_LIMIT))

        try:
            result = subprocess.run(
                _sigil_search_args(query, self._search_namespaces, limit),
                timeout=_SEARCH_TIMEOUT_S,
                capture_output=True,
                text=True,
                check=False,
            )
        except Exception as exc:  # noqa: BLE001
            return _err(_clean_text(f"sigil search failed: {exc}"))

        if result.returncode != 0:
            return _err(_clean_text(result.stderr or "search exited non-zero"))
        return _ok({"results": _clean_text(result.stdout)})

    def _tool_remember(self, args: Dict[str, Any]) -> str:
        fact = (args.get("fact") or "").strip()
        if not fact:
            return _err("fact is required")

        try:
            result = subprocess.run(
                ["sigil", "remember", fact, f"--namespace={self._namespace}"],
                timeout=_REMEMBER_TIMEOUT_S,
                capture_output=True,
                text=True,
                check=False,
            )
        except Exception as exc:  # noqa: BLE001
            return _err(_clean_text(f"sigil remember failed: {exc}"))

        if result.returncode != 0:
            return _err(_clean_text(result.stderr or "remember exited non-zero"))
        return _ok({"ok": True, "namespace": self._namespace})

    # -- Config --------------------------------------------------------------
    #
    # Sigil reads its own ~/.sigil/config.json.
    # Hermes doesn't need to know any of that — we return an empty schema so
    # `hermes memory setup` doesn't ask redundant questions.

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return []

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        # No-op — Sigil owns its own config at ~/.sigil/config.json. Run `sigil init`
        # to (re)configure it.
        return None


# ---------------------------------------------------------------------------
# Plugin entry point
# ---------------------------------------------------------------------------

def register(ctx: Any) -> None:
    """Called by Hermes' memory plugin discovery system."""
    ctx.register_memory_provider(SigilProvider())
