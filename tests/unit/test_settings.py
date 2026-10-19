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
