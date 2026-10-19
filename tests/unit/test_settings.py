import pytest
from pydantic import ValidationError

from projects.backend.shared.configuration.settings import Settings


@pytest.mark.parametrize("host", ["smtp.example.com", "0.0.0.0"])
def test_production_email_hosts_rejected(host):
    with pytest.raises(ValidationError, match="loopback"):
        Settings(mailpit_host=host)


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com",
        "http://0.0.0.0:11434",
        "http://user:pass@localhost:11434",
        "http://localhost:11434/path",
    ],
)
def test_nonlocal_model_origins_rejected(url):
    with pytest.raises(ValidationError, match="loopback"):
        Settings(ollama_url=url)


def test_no_model_chosen_by_default(settings):
    assert settings.ollama_model is None
    assert settings.database.parent == settings.evidence_dir.parent


def test_blank_model_is_not_configured():
    assert Settings(ollama_model="  ").ollama_model is None


def test_gemini_provider_and_key_are_normalized():
    settings = Settings(
        model_provider=" Gemini ",
        gemini_api_key=" test-key ",
        gemini_model=" gemini-2.5-flash ",
    )
    assert settings.model_provider == "gemini"
    assert settings.gemini_api_key == "test-key"
    assert settings.gemini_model == "gemini-2.5-flash"


def test_unknown_model_provider_is_rejected():
    with pytest.raises(ValidationError, match="Model provider"):
        Settings(model_provider="unknown")


def test_admin_token_and_cors_origins_are_restricted():
    with pytest.raises(ValidationError, match="at least 32 characters"):
        Settings(admin_api_token="weak")
    with pytest.raises(ValidationError, match="CORS origins"):
        Settings(cors_origins=["*"])
    settings = Settings(cors_origins=["https://reader.example.com/"])
    assert settings.cors_origins == ["https://reader.example.com"]
