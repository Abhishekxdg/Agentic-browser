"""Agent Browser Infrastructure SDK for Python.

Provides a simple interface to execute AI agent intents on any website
via the Agent Browser execution engine.
"""

from .client import AgentBrowser
from .native import SemanticBrowser
from .types import ExecutionResult, AuthConfig

__all__ = ["AgentBrowser", "SemanticBrowser", "ExecutionResult", "AuthConfig"]
__version__ = "0.1.0"
