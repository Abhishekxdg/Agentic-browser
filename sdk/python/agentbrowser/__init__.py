"""Sound Browser Infrastructure SDK for Python.

Provides a simple interface to execute AI agent intents on any website
via the Sound Browser execution engine.
"""

from .client import AgentBrowser
from .native import SemanticBrowser
from .types import ExecutionResult, AuthConfig

SoundBrowser = AgentBrowser

__all__ = ["AgentBrowser", "SoundBrowser", "SemanticBrowser", "ExecutionResult", "AuthConfig"]
__version__ = "0.1.0"
