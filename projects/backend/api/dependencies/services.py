from fastapi import Request

from projects.backend.shared.configuration.settings import Settings
from projects.backend.shared.model_inference.ollama import ModelRuntime


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_model(request: Request) -> ModelRuntime:
    return request.app.state.model
