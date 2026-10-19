from projects.backend.modules.communities import locations
from tests import library_world

ADMIN_TOKEN = "t" * 40


def test_admin_api_fails_closed_without_token(client, settings):
    assert client.get("/api/admin/locations").status_code == 503
    settings.admin_api_token = ADMIN_TOKEN
    assert client.get("/api/admin/locations").status_code == 401
    assert client.get(
        "/api/admin/locations", headers={"Authorization": ADMIN_TOKEN}
    ).status_code == 401


def test_admin_updates_sources_triggers_and_reports_jobs(client, settings):
    settings.admin_api_token = ADMIN_TOKEN
    headers = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
    profile = library_world.onboard(settings.database)

    response = client.get("/api/admin/locations", headers=headers)
    assert response.status_code == 200
    assert response.json()["locations"][0]["id"] == library_world.LOCATION_ID

    response = client.patch(
        f"/api/admin/locations/{library_world.LOCATION_ID}/sources",
        headers=headers,
        json={
            "systems": [
                {"fscskey": system["fscskey"], "website": system["website"]}
                for system in profile["systems"]
            ],
            "government": {"platform": "civicclerk", "tenant": "seattle"},
        },
    )
    assert response.status_code == 200
    saved = locations.get(settings.database, library_world.LOCATION_ID)
    assert saved["government"]["platform"] == "civicclerk"

    response = client.post(
        f"/api/admin/locations/{library_world.LOCATION_ID}/ingestion", headers=headers
    )
    assert response.status_code == 200
    job_id = response.json()["job_id"]
    listed = client.get("/api/admin/jobs", headers=headers).json()["jobs"]
    assert any(job["id"] == job_id and job["status"] == "pending" for job in listed)

    channel = client.get("/api/admin/channels", headers=headers).json()["channels"][0]
    assert channel["id"] == "reader-site" and channel["enabled"] is True


def test_admin_source_settings_validate_https_and_source_identity(client, settings):
    settings.admin_api_token = ADMIN_TOKEN
    headers = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
    library_world.onboard(settings.database)
    payload = {
        "systems": [
            {"fscskey": "WA0001", "website": "http://insecure.example"},
            {"fscskey": "WA0002", "website": None},
        ],
        "government": None,
    }
    response = client.patch(
        f"/api/admin/locations/{library_world.LOCATION_ID}/sources",
        headers=headers,
        json=payload,
    )
    assert response.status_code == 422

    payload["systems"][0] = {"fscskey": "unknown", "website": None}
    response = client.patch(
        f"/api/admin/locations/{library_world.LOCATION_ID}/sources",
        headers=headers,
        json=payload,
    )
    assert response.status_code == 422
