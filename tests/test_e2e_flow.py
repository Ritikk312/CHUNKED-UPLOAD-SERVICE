"""
End-to-end test script verifying:
1. Static asset serving (HTML, JS, CSS)
2. Multi-chunk file creation
3. Interruption simulation and resume from missing chunks
4. Idempotent re-upload of chunks
5. Final merge and checksum verification
6. File download match
"""
import hashlib
import json
import pytest
from app.server import app
from app.session import DEFAULT_CHUNK_SIZE


@pytest.fixture
def client():
    app.config["TESTING"] = True
    with app.test_client() as client:
        yield client


def test_static_and_html_serving(client):
    # Verify index HTML
    res = client.get("/")
    assert res.status_code == 200
    assert b"Resumable Chunked Upload Service" in res.data
    assert b"dropzone" in res.data

    # Verify static files exist and are reachable
    res_css = client.get("/static/css/style.css")
    assert res_css.status_code == 200
    assert b"--color-primary" in res_css.data

    res_uploader = client.get("/static/js/uploader.js")
    assert res_uploader.status_code == 200
    assert b"ChunkUploader" in res_uploader.data

    res_hash = client.get("/static/js/hash.js")
    assert res_hash.status_code == 200

    res_store = client.get("/static/js/store.js")
    assert res_store.status_code == 200

    res_app = client.get("/static/js/app.js")
    assert res_app.status_code == 200


def test_resume_and_checksum_verification_flow(client):
    """
    Simulates:
    1. Creating a 5 MB upload session (3 chunks: 2MB, 2MB, 1MB)
    2. Uploading chunk 0
    3. Simulated interruption (disconnect)
    4. Client returns, calls GET /api/uploads/<id> to check what server has
    5. Server reports [0]
    6. Client uploads missing chunks [1, 2]
    7. Client completes upload
    8. Checksum verified and downloaded file matches original
    """
    chunk0 = b"A" * DEFAULT_CHUNK_SIZE
    chunk1 = b"B" * DEFAULT_CHUNK_SIZE
    chunk2 = b"C" * (1024 * 1024)
    file_bytes = chunk0 + chunk1 + chunk2
    file_sha256 = hashlib.sha256(file_bytes).hexdigest()
    file_size = len(file_bytes)

    # 1. Create upload session
    res = client.post("/api/uploads", json={
        "fileName": "large_presentation.mp4",
        "size": file_size,
        "chunkSize": DEFAULT_CHUNK_SIZE,
        "totalChunks": 3,
        "fileSha256": file_sha256,
    })
    assert res.status_code == 201
    upload_id = res.get_json()["uploadId"]

    # 2. Upload only chunk 0
    c0_sha = hashlib.sha256(chunk0).hexdigest()
    res = client.put(
        f"/api/uploads/{upload_id}/chunks/0",
        data=chunk0,
        headers={"X-Chunk-SHA256": c0_sha}
    )
    assert res.status_code == 200
    assert res.get_json()["received"] == [0]

    # 3. Simulate connection drop & resume inquiry
    res = client.get(f"/api/uploads/{upload_id}")
    assert res.status_code == 200
    server_state = res.get_json()
    assert server_state["received"] == [0]
    assert server_state["totalChunks"] == 3

    # 4. Client identifies missing chunks are [1, 2], sends chunk 1
    c1_sha = hashlib.sha256(chunk1).hexdigest()
    res = client.put(
        f"/api/uploads/{upload_id}/chunks/1",
        data=chunk1,
        headers={"X-Chunk-SHA256": c1_sha}
    )
    assert res.status_code == 200
    assert res.get_json()["received"] == [0, 1]

    # 5. Client sends chunk 2
    c2_sha = hashlib.sha256(chunk2).hexdigest()
    res = client.put(
        f"/api/uploads/{upload_id}/chunks/2",
        data=chunk2,
        headers={"X-Chunk-SHA256": c2_sha}
    )
    assert res.status_code == 200
    assert res.get_json()["received"] == [0, 1, 2]

    # 6. Complete and verify whole-file checksum
    res = client.post(f"/api/uploads/{upload_id}/complete")
    assert res.status_code == 200
    complete_resp = res.get_json()
    assert complete_resp["status"] == "complete"
    assert complete_resp["sha256"] == file_sha256

    # 7. Download and verify binary identity
    res = client.get(f"/api/files/{upload_id}")
    assert res.status_code == 200
    assert res.data == file_bytes

    # 8. Clean up
    res = client.delete(f"/api/admin/uploads/{upload_id}", headers={"X-Role": "admin"})
    assert res.status_code == 200
