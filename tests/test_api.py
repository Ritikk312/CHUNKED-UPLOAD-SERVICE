"""
Integration tests for Flask API endpoints:
- POST /api/uploads
- GET /api/uploads/<id>
- PUT /api/uploads/<id>/chunks/<index>
- POST /api/uploads/<id>/complete
- GET /api/files/<id>
- Admin endpoints (GET /api/admin/uploads, DELETE /api/admin/uploads/<id>)
- Flaky test mode endpoint
"""
import hashlib
import json
import pytest
from app.server import app, flaky_config
from app.session import UploadSession, DEFAULT_CHUNK_SIZE


@pytest.fixture
def client():
    app.config["TESTING"] = True
    flaky_config["fail_rate"] = 0  # ensure flaky mode off for normal tests
    with app.test_client() as client:
        yield client


def test_full_api_upload_flow(client):
    content = b"Hello, this is a resumable chunked upload test file with some text!"
    file_sha256 = hashlib.sha256(content).hexdigest()
    file_size = len(content)

    # 1. Create upload session
    res = client.post("/api/uploads", json={
        "fileName": "demo.txt",
        "size": file_size,
        "chunkSize": DEFAULT_CHUNK_SIZE,
        "totalChunks": 1,
        "fileSha256": file_sha256,
    })
    assert res.status_code == 201
    data = res.get_json()
    upload_id = data["uploadId"]
    assert upload_id.startswith("u_")

    # 2. Check session info before chunk upload
    res = client.get(f"/api/uploads/{upload_id}")
    assert res.status_code == 200
    session_data = res.get_json()
    assert session_data["received"] == []
    assert session_data["status"] == "uploading"

    # 3. Upload chunk with hash mismatch -> 409
    res = client.put(
        f"/api/uploads/{upload_id}/chunks/0",
        data=content,
        headers={"X-Chunk-SHA256": "0" * 64}
    )
    assert res.status_code == 409

    # 4. Upload chunk with correct hash -> 200
    chunk_sha256 = hashlib.sha256(content).hexdigest()
    res = client.put(
        f"/api/uploads/{upload_id}/chunks/0",
        data=content,
        headers={"X-Chunk-SHA256": chunk_sha256}
    )
    assert res.status_code == 200
    assert res.get_json()["received"] == [0]

    # 5. Idempotent re-send of chunk 0 -> 200
    res = client.put(
        f"/api/uploads/{upload_id}/chunks/0",
        data=content,
        headers={"X-Chunk-SHA256": chunk_sha256}
    )
    assert res.status_code == 200

    # 6. Complete upload
    res = client.post(f"/api/uploads/{upload_id}/complete")
    assert res.status_code == 200
    complete_data = res.get_json()
    assert complete_data["status"] == "complete"
    assert "downloadUrl" in complete_data

    # 7. Download file
    res = client.get(f"/api/files/{upload_id}")
    assert res.status_code == 200
    assert res.data == content

    # 8. Admin listing
    res = client.get("/api/admin/uploads")
    assert res.status_code == 403  # Missing admin role

    res = client.get("/api/admin/uploads", headers={"X-Role": "admin"})
    assert res.status_code == 200
    admin_data = res.get_json()
    assert any(u["uploadId"] == upload_id for u in admin_data["uploads"])

    # 9. Clean up via Admin delete
    res = client.delete(f"/api/admin/uploads/{upload_id}", headers={"X-Role": "admin"})
    assert res.status_code == 200


def test_flaky_test_endpoint(client):
    res = client.get("/api/test/flaky?fail=20&kill_at=50")
    assert res.status_code == 200
    data = res.get_json()
    assert data["flakyFailRate"] == 20
    assert data["killAtPercent"] == 50

    # reset
    res = client.get("/api/test/flaky?fail=0&kill_at=0")
    assert res.status_code == 200
    assert res.get_json()["flakyFailRate"] == 0
    assert res.get_json()["killAtPercent"] == 0


def test_kill_connection_at_percentage(client):
    """Verifies that the server drops connection once at chosen progress %."""
    # Set kill connection rule at 50%
    client.get("/api/test/flaky?fail=0&kill_at=50")

    chunk0 = b"A" * DEFAULT_CHUNK_SIZE
    chunk1 = b"B" * DEFAULT_CHUNK_SIZE
    payload = chunk0 + chunk1
    file_sha256 = hashlib.sha256(payload).hexdigest()

    res = client.post("/api/uploads", json={
        "fileName": "kill_test.bin",
        "size": len(payload),
        "chunkSize": DEFAULT_CHUNK_SIZE,
        "totalChunks": 2,
        "fileSha256": file_sha256,
    })
    upload_id = res.get_json()["uploadId"]

    # Chunk 0 corresponds to (0+1)/2 = 50% progress -> triggers simulated connection severance (503)
    sha0 = hashlib.sha256(chunk0).hexdigest()
    res = client.put(
        f"/api/uploads/{upload_id}/chunks/0",
        data=chunk0,
        headers={"X-Chunk-SHA256": sha0}
    )
    assert res.status_code == 503
    assert "Simulated connection severed" in res.get_json()["error"]

    # Immediate retry of Chunk 0 succeeds because session has already triggered the severance once
    res = client.put(
        f"/api/uploads/{upload_id}/chunks/0",
        data=chunk0,
        headers={"X-Chunk-SHA256": sha0}
    )
    assert res.status_code == 200

    # Chunk 1 succeeds without drop
    sha1 = hashlib.sha256(chunk1).hexdigest()
    res = client.put(
        f"/api/uploads/{upload_id}/chunks/1",
        data=chunk1,
        headers={"X-Chunk-SHA256": sha1}
    )
    assert res.status_code == 200

    # Complete upload succeeds
    res = client.post(f"/api/uploads/{upload_id}/complete")
    assert res.status_code == 200
    assert res.get_json()["status"] == "complete"

    # Clean up
    client.get("/api/test/flaky?fail=0&kill_at=0")
    client.delete(f"/api/admin/uploads/{upload_id}", headers={"X-Role": "admin"})


def test_download_rejected_for_incomplete_file(client):
    """Verifies that downloading only works for completed files."""
    chunk = b"Z" * 100
    sha = hashlib.sha256(chunk).hexdigest()

    res = client.post("/api/uploads", json={
        "fileName": "incomplete.bin",
        "size": 100,
        "chunkSize": DEFAULT_CHUNK_SIZE,
        "totalChunks": 1,
        "fileSha256": sha,
    })
    upload_id = res.get_json()["uploadId"]

    # Try downloading before chunks or completion -> 400
    res = client.get(f"/api/files/{upload_id}")
    assert res.status_code == 400

    # Non-existent upload -> 404
    res = client.get("/api/files/u_nonexistent")
    assert res.status_code == 404

    # Clean up
    client.delete(f"/api/admin/uploads/{upload_id}", headers={"X-Role": "admin"})
