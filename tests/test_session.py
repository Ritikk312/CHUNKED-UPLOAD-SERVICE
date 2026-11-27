"""
Unit tests for UploadSession logic:
- Creation and validation
- Chunk saving and idempotency
- Chunk SHA-256 validation
- Reassembly in order and whole-file checksum verification
- Edge cases from PRD: exactly 2 MB, 2 MB + 1 byte, 1 byte
"""
import shutil
import hashlib
import tempfile
from pathlib import Path
import pytest
from app.session import UploadSession, DEFAULT_CHUNK_SIZE, MAX_FILE_SIZE


@pytest.fixture
def temp_storage():
    """Create isolated temporary storage directories for testing."""
    temp_dir = Path(tempfile.mkdtemp(prefix="upload_test_"))
    uploads_dir = temp_dir / "uploads"
    files_dir = temp_dir / "files"
    uploads_dir.mkdir(parents=True)
    files_dir.mkdir(parents=True)
    yield uploads_dir, files_dir
    shutil.rmtree(temp_dir, ignore_errors=True)


def test_session_validation(temp_storage):
    uploads_dir, files_dir = temp_storage

    # Empty filename
    with pytest.raises(ValueError, match="File name is required"):
        UploadSession.create("", 100, DEFAULT_CHUNK_SIZE, 1, "a" * 64, uploads_dir, files_dir)

    # Size 0
    with pytest.raises(ValueError, match="File size must be greater than 0"):
        UploadSession.create("test.mp4", 0, DEFAULT_CHUNK_SIZE, 1, "a" * 64, uploads_dir, files_dir)

    # No fixed upper limit: 10 GB and 1 TB sessions are accepted
    assert MAX_FILE_SIZE is None
    ten_gb = 10 * 1024 * 1024 * 1024
    large_session = UploadSession.create(
        "archive_10gb.tar", ten_gb, DEFAULT_CHUNK_SIZE, 5120, "a" * 64, uploads_dir, files_dir
    )
    assert large_session.total_chunks == 5120

    one_tb = 1024 * 1024 * 1024 * 1024
    huge_session = UploadSession.create(
        "dataset_1tb.bin", one_tb, DEFAULT_CHUNK_SIZE, 524288, "a" * 64, uploads_dir, files_dir
    )
    assert huge_session.total_chunks == 524288

    # Invalid SHA-256
    with pytest.raises(ValueError, match="valid 64-character hexadecimal"):
        UploadSession.create("test.mp4", 100, DEFAULT_CHUNK_SIZE, 1, "invalid_hash", uploads_dir, files_dir)

    # Mismatched totalChunks
    with pytest.raises(ValueError, match="does not match expected chunk count"):
        # 5 MB with 2 MB chunks should be 3 chunks, not 2
        UploadSession.create("test.mp4", 5 * 1024 * 1024, DEFAULT_CHUNK_SIZE, 2, "a" * 64, uploads_dir, files_dir)


def test_chunk_upload_and_merge_success(temp_storage):
    uploads_dir, files_dir = temp_storage

    # Create dummy data: 5 MB file (chunk size 2MB -> 3 chunks: 2MB, 2MB, 1MB)
    chunk_size = 2 * 1024 * 1024
    chunk0 = b"A" * chunk_size
    chunk1 = b"B" * chunk_size
    chunk2 = b"C" * (1024 * 1024)
    file_bytes = chunk0 + chunk1 + chunk2
    total_size = len(file_bytes)
    file_sha256 = hashlib.sha256(file_bytes).hexdigest()

    session = UploadSession.create(
        file_name="video.mp4",
        size=total_size,
        chunk_size=chunk_size,
        total_chunks=3,
        file_sha256=file_sha256,
        uploads_dir=uploads_dir,
        files_dir=files_dir,
    )

    assert session.upload_id.startswith("u_")
    assert session.total_chunks == 3
    assert session.received == []

    # Save chunk 0 with SHA-256 header check
    sha0 = hashlib.sha256(chunk0).hexdigest()
    session.save_chunk(0, chunk0, expected_sha256=sha0)
    assert session.received == [0]

    # Test Idempotency: saving chunk 0 again succeeds without duplicates
    session.save_chunk(0, chunk0, expected_sha256=sha0)
    assert session.received == [0]

    # Test chunk hash mismatch rejection
    sha1 = hashlib.sha256(chunk1).hexdigest()
    with pytest.raises(ValueError, match="Chunk SHA-256 mismatch"):
        session.save_chunk(1, chunk1, expected_sha256="wronghash" + "0" * 55)

    # Save chunk 2 before chunk 1 (out of order arrival)
    sha2 = hashlib.sha256(chunk2).hexdigest()
    session.save_chunk(2, chunk2, expected_sha256=sha2)
    assert session.received == [0, 2]

    # Trying to complete when missing chunk 1 must fail
    with pytest.raises(ValueError, match="missing chunks"):
        session.complete()

    # Save chunk 1
    session.save_chunk(1, chunk1, expected_sha256=sha1)
    assert session.received == [0, 1, 2]

    # Complete upload - merges in index order (0, 1, 2)
    result = session.complete()
    assert result["status"] == "complete"
    assert result["sha256"] == file_sha256

    # Verify merged file on disk matches exact contents
    merged_path = Path(result["filePath"])
    assert merged_path.exists()
    assert merged_path.read_bytes() == file_bytes


def test_checksum_failure_handling(temp_storage):
    uploads_dir, files_dir = temp_storage

    chunk = b"X" * 1024
    corrupted_expected_hash = hashlib.sha256(b"Y" * 1024).hexdigest()

    session = UploadSession.create(
        file_name="corrupt_test.txt",
        size=len(chunk),
        chunk_size=DEFAULT_CHUNK_SIZE,
        total_chunks=1,
        file_sha256=corrupted_expected_hash,  # Expecting hash of "Y", but we upload "X"
        uploads_dir=uploads_dir,
        files_dir=files_dir,
    )

    session.save_chunk(0, chunk)
    result = session.complete()

    assert result["status"] == "checksum_failed"
    assert session.status == "checksum_failed"
    # Corrupted merged file must not exist on disk
    assert not session.merged_file_path.exists()


@pytest.mark.parametrize("payload", [
    b"Z",                                          # 1 byte
    b"A" * DEFAULT_CHUNK_SIZE,                     # exactly 2 MB
    b"B" * DEFAULT_CHUNK_SIZE + b"!",             # 2 MB + 1 byte
], ids=["1_byte", "exact_2mb", "2mb_plus_1_byte"])
def test_odd_and_boundary_file_sizes(temp_storage, payload):
    """PRD Page 14 requirement: test odd sizes (1 byte, exactly 2 MB, 2 MB + 1 byte)"""
    uploads_dir, files_dir = temp_storage
    size = len(payload)
    chunk_size = DEFAULT_CHUNK_SIZE
    file_sha256 = hashlib.sha256(payload).hexdigest()

    session = UploadSession.create(
        file_name="boundary_test.bin",
        size=size,
        chunk_size=chunk_size,
        file_sha256=file_sha256,
        uploads_dir=uploads_dir,
        files_dir=files_dir,
    )

    # Upload chunks sequentially
    for i in range(session.total_chunks):
        start = i * chunk_size
        end = min(start + chunk_size, size)
        chunk_data = payload[start:end]
        session.save_chunk(i, chunk_data, expected_sha256=hashlib.sha256(chunk_data).hexdigest())

    result = session.complete()
    assert result["status"] == "complete"
    assert result["sha256"] == file_sha256
    assert Path(result["filePath"]).read_bytes() == payload
