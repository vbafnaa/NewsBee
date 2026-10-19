import secrets
from typing import Annotated

from fastapi import Depends, Header, HTTPException

from projects.backend.api.dependencies.services import get_settings
from projects.backend.shared.configuration.settings import Settings


def require_admin(
    authorization: Annotated[str | None, Header()] = None,
    settings: Settings = Depends(get_settings),
) -> None:
    if not settings.admin_api_token:
        raise HTTPException(503, "Admin API is not configured")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Admin authentication required")
    supplied = authorization.removeprefix("Bearer ")
    if not secrets.compare_digest(supplied, settings.admin_api_token):
        raise HTTPException(401, "Admin authentication required")
