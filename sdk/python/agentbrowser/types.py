from dataclasses import dataclass
from typing import Optional, Dict, Any


@dataclass
class AuthConfig:
    """Authentication configuration for a site."""
    username: Optional[str] = None
    password: Optional[str] = None
    totp_secret: Optional[str] = None
    oauth_provider: Optional[str] = None
    oauth_refresh_token: Optional[str] = None
    mfa_type: Optional[str] = "none"  # "totp", "sms", "none"


@dataclass
class ExecutionResult:
    """Result of executing an intent on a website."""
    status: str  # "success", "error", "auth_required", "captcha"
    data: Optional[Dict[str, Any]] = None
    screenshot: Optional[str] = None  # base64
    steps_executed: int = 0
    strategy_used: str = ""
    error: Optional[str] = None
    reasoning: Optional[str] = None
