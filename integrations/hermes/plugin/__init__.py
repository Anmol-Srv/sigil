"""Sigil memory provider for Hermes Agent.

Bridges Hermes' memory system to a local Sigil install via the `sigil` CLI.
No new network surface — the plugin shells out to the same subprocess
commands Claude Code uses through its hooks. This means Hermes inherits
all of Sigil's behavior for free: AUDM dedup, Hebbian retrieval, hot-context
budgets, pod-aware blending, the lot.

Architecture
------------
    prefetch(query)     → `sigil search <q> --namespace=<ns>,default`
    sync_turn(u, a)     → `sigil remember --bg "<user_content>"` (daemon thread)
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

Search reads across the platform's own namespace AND `default` — the
namespace Claude Code's hooks write to from the user's laptop. Result:
facts captured anywhere are reachable from anywhere, with natural source
classification (a Hermes-iMessage fact lives in `hermes-imessage`, a
laptop-Claude-Code fact lives in `default`, but both surface in any
search).

Requires
--------
    sigil  CLI on PATH (the local install — `npm install -g @anmolsrv/sigil`
           or wherever the binary is installed)
    ~/.sigil/.env  configured (run `sigil init` once before activating
                   this plugin)
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import threading
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

# Subprocess timeouts. Search is on the prompt-critical path → tight budget.
# Remember is fire-and-forget via --bg, but we still cap the spawn-and-detach.
_SEARCH_TIMEOUT_S = 5
_REMEMBER_TIMEOUT_S = 10
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
        "--no-graph",
        "--no-route",
        "--no-synthesize",
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
        self._sync_thread: Optional[threading.Thread] = None

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
        # Cross-namespace search: this platform's facts PLUS the default
        # namespace where Claude Code writes from the user's other machines.
        self._search_namespaces = f"{self._namespace},default"
        self._hermes_home = kwargs.get("hermes_home", "")
        logger.info(
            "Sigil provider initialised: namespace=%s session=%s platform=%s",
            self._namespace, session_id, self._platform,
        )

    def shutdown(self) -> None:
        if self._sync_thread and self._sync_thread.is_alive():
            self._sync_thread.join(timeout=5.0)

    # -- Recall (per-turn) ---------------------------------------------------

    def system_prompt_block(self) -> str:
        return (
            "## Memory (Sigil)\n"
            "Persistent memory across all your sessions and the user's other AI tools "
            "(Claude Code, Cursor, Codex CLI, Kiro). Recent relevant facts are "
            f"auto-injected at the top of each turn from namespaces `{self._search_namespaces}`. "
            "Trust the injection — answer from it first.\n\n"
            "Call `sigil_search` ONLY for drill-down questions when the injection "
            "clearly missed something specific. Call `sigil_remember` ONLY when the "
            "user explicitly asks (\"remember that...\", \"save this...\") or when "
            "they share a critical fact mid-turn that the Stop-equivalent flush will "
            "miss."
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Synchronous recall before the next API call.

        Calls `sigil search` against this platform's namespace plus `default`
        (the cross-machine shared brain). Returns the raw CLI output as
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
        """Persist memorable content from the just-completed turn.

        Sigil's `remember` command runs its own classifier + AUDM dedup, so
        we don't try to be clever about what's "memorable" — just hand
        the user message over and let Sigil decide.

        Background thread is belt-and-braces: `sigil remember --bg` already
        spawns a detached subprocess, but wrapping it in a daemon thread
        means the .run() call itself can't block sync_turn.
        """
        text = (user_content or "").strip()
        if not text:
            return

        # Sigil's CLI takes facts as positional args. We send the raw user
        # message — its ingestion pipeline classifies, extracts, dedupes.
        # Trimming to a sensible upper bound avoids enormous argv on long
        # pasted content.
        snippet = text[:4000]

        def _save() -> None:
            try:
                subprocess.run(
                    ["sigil", "remember", "--bg", snippet],
                    env={**os.environ, "DEFAULT_NAMESPACE": self._namespace},
                    timeout=_REMEMBER_TIMEOUT_S,
                    capture_output=True,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("sigil remember failed: %s", exc)

        # If the previous turn's sync is still running, let it finish first
        # so we don't pile up zombie threads on chatty sessions.
        if self._sync_thread and self._sync_thread.is_alive():
            self._sync_thread.join(timeout=5.0)
        self._sync_thread = threading.Thread(target=_save, daemon=True)
        self._sync_thread.start()

    # -- Tools (explicit invocation by the model) ----------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [
            {
                "name": "sigil_search",
                "description": (
                    "Search persistent memory across all of the user's AI sessions "
                    "(this Hermes platform + their laptop's Claude Code / Cursor / "
                    "Codex / Kiro). Use for drill-down questions when the "
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
                    "ONLY when the user explicitly asks to remember something, or "
                    "when they share a critical mid-turn fact. Routine facts are "
                    "captured automatically — don't double-save."
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
                ["sigil", "remember", "--bg", fact],
                env={**os.environ, "DEFAULT_NAMESPACE": self._namespace},
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
    # Sigil reads its own ~/.sigil/.env (DB connection, embedder, LLM provider).
    # Hermes doesn't need to know any of that — we return an empty schema so
    # `hermes memory setup` doesn't ask redundant questions.

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return []

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        # No-op — Sigil owns its own config at ~/.sigil/.env. Run `sigil init`
        # to (re)configure it.
        return None


# ---------------------------------------------------------------------------
# Plugin entry point
# ---------------------------------------------------------------------------

def register(ctx: Any) -> None:
    """Called by Hermes' memory plugin discovery system."""
    ctx.register_memory_provider(SigilProvider())
