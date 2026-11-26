import os
import json
import math
import re
import uuid
import hashlib
import shutil
from datetime import datetime, timezone
from pathlib import Path
from werkzeug.utils import secure_filename

# Default chunk size: 2 MB = 2,097,152 bytes
DEFAULT_CHUNK_SIZE = 2 * 1024 * 1024
MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024  # 10 GB limit
BASE_STORAGE_DIR = Path(__file__).resolve().parent.parent / "storage"
UPLOADS_DIR = BASE_STORAGE_DIR / "uploads"
FILES_DIR = BASE_STORAGE_DIR / "files"


class UploadSession:
    """
    Manages the lifecycle of a chunked upload session:
    - Session creation and metadata storage (JSON)
    - Idempotent chunk saving with per-chunk SHA-256 verification
    - In-order merging and whole-file SHA-256 checksum verification
    """

    def __init__(self, meta_dict, uploads_dir=None, files_dir=None):
        self.meta = meta_dict
        self.uploads_dir = Path(uploads_dir) if uploads_dir else UPLOADS_DIR
        self.files_dir = Path(files_dir) if files_dir else FILES_DIR

    @property
    def upload_id(self):
        return self.meta["uploadId"]

    @property
    def file_name(self):
        return self.meta["fileName"]

    @property
    def original_file_name(self):
        return self.meta.get("originalFileName", self.file_name)

    @property
    def size(self):
        return self.meta["size"]

    @property
    def chunk_size(self):
        return self.meta["chunkSize"]

    @property
    def total_chunks(self):
        return self.meta["totalChunks"]

    @property
    def file_sha256(self):
        return self.meta["fileSha256"]

    @property
    def status(self):
        return self.meta.get("status", "uploading")

    @status.setter
    def status(self, val):
        self.meta["status"] = val

    @property
    def received(self):
        return self.meta.get("received", [])

    @property
    def session_dir(self):
        return self.uploads_dir / self.upload_id

    @property
    def chunks_dir(self):
        return self.session_dir / "chunks"

    @property
    def meta_path(self):
        return self.session_dir / "meta.json"

    @property
    def merged_file_path(self):
        safe_name = secure_filename(self.file_name) or "uploaded_file"
        return self.files_dir / f"{self.upload_id}_{safe_name}"

    def save_meta(self):
        """Persist metadata to JSON file atomically."""
        self.meta["updatedAt"] = datetime.now(timezone.utc).isoformat()
        temp_meta = self.session_dir / "meta.json.tmp"
        with open(temp_meta, "w", encoding="utf-8") as f:
            json.dump(self.meta, f, indent=2)
        temp_meta.replace(self.meta_path)

    @classmethod
    def validate_creation_params(cls, file_name, size, chunk_size, total_chunks, file_sha256):
        """Strict validation of parameters for creating an upload session."""
        if not file_name or not isinstance(file_name, str) or not file_name.strip():
            raise ValueError("File name is required and cannot be empty.")

        if not isinstance(size, int) or size <= 0:
            raise ValueError("File size must be greater than 0 bytes.")

        if size > MAX_FILE_SIZE:
            max_gb = MAX_FILE_SIZE // (1024 * 1024 * 1024)
            raise ValueError(f"File size exceeds maximum allowed limit of {max_gb} GB.")

        if not isinstance(chunk_size, int) or chunk_size <= 0:
            raise ValueError("Chunk size must be a positive integer.")

        expected_total_chunks = math.ceil(size / chunk_size)
        if total_chunks != expected_total_chunks:
            raise ValueError(
                f"totalChunks ({total_chunks}) does not match expected chunk count ({expected_total_chunks}) "
                f"for size {size} and chunkSize {chunk_size}."
            )

        if not file_sha256 or not isinstance(file_sha256, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", file_sha256):
            raise ValueError("fileSha256 must be a valid 64-character hexadecimal SHA-256 string.")

    @classmethod
    def create(cls, file_name, size, chunk_size=DEFAULT_CHUNK_SIZE, total_chunks=None, file_sha256="", uploads_dir=None, files_dir=None):
        """Creates a new upload session, initial folders, and meta.json."""
        if total_chunks is None:
            total_chunks = math.ceil(size / chunk_size)

        cls.validate_creation_params(file_name, size, chunk_size, total_chunks, file_sha256)

        upload_id = f"u_{uuid.uuid4().hex[:8]}"
        now_str = datetime.now(timezone.utc).isoformat()

        safe_name = secure_filename(file_name) or "uploaded_file"

        meta = {
            "uploadId": upload_id,
            "fileName": safe_name,
            "originalFileName": file_name,
            "size": size,
            "chunkSize": chunk_size,
            "totalChunks": total_chunks,
            "fileSha256": file_sha256.lower(),
            "received": [],
            "status": "uploading",
            "createdAt": now_str,
            "updatedAt": now_str,
        }

        up_dir = Path(uploads_dir) if uploads_dir else UPLOADS_DIR
        f_dir = Path(files_dir) if files_dir else FILES_DIR

        session = cls(meta, uploads_dir=up_dir, files_dir=f_dir)
        session.chunks_dir.mkdir(parents=True, exist_ok=True)
        session.files_dir.mkdir(parents=True, exist_ok=True)
        session.save_meta()

        return session

    @classmethod
    def get(cls, upload_id, uploads_dir=None, files_dir=None):
        """Retrieve existing upload session by ID."""
        up_dir = Path(uploads_dir) if uploads_dir else UPLOADS_DIR
        f_dir = Path(files_dir) if files_dir else FILES_DIR
        meta_file = up_dir / upload_id / "meta.json"

        if not meta_file.exists():
            return None

        try:
            with open(meta_file, "r", encoding="utf-8") as f:
                meta = json.load(f)
            session = cls(meta, uploads_dir=up_dir, files_dir=f_dir)
            session.sync_received_chunks()
            return session
        except Exception:
            return None

    def chunk_file_path(self, index):
        """Standardized naming for chunk files: 000000.part"""
        return self.chunks_dir / f"{index:06d}.part"

    def sync_received_chunks(self):
        """Ensure received chunk list reflects actual files on disk."""
        if not self.chunks_dir.exists():
            disk_chunks = []
        else:
            disk_chunks = []
            for item in self.chunks_dir.glob("*.part"):
                stem = item.stem
                if stem.isdigit():
                    disk_chunks.append(int(stem))
        disk_chunks.sort()
        if self.meta.get("received") != disk_chunks:
            self.meta["received"] = disk_chunks
            self.save_meta()
        return disk_chunks

    def save_chunk(self, index, chunk_bytes, expected_sha256=None):
        """
        Idempotently saves a chunk:
        - Validates chunk index and length
        - Checks per-chunk SHA-256 (if header provided)
        - Writes atomically
        - Updates received index in metadata
        """
        if self.status == "complete":
            raise ValueError("Upload session is already complete.")

        if not isinstance(index, int) or index < 0 or index >= self.total_chunks:
            raise IndexError(f"Chunk index {index} out of bounds (0 to {self.total_chunks - 1}).")

        # Determine expected chunk length
        is_last = (index == self.total_chunks - 1)
        if not is_last:
            expected_len = self.chunk_size
        else:
            expected_len = self.size - (self.total_chunks - 1) * self.chunk_size

        if len(chunk_bytes) != expected_len:
            raise ValueError(
                f"Invalid chunk size for chunk {index}: received {len(chunk_bytes)} bytes, "
                f"expected {expected_len} bytes."
            )

        # Calculate chunk SHA-256
        actual_chunk_sha = hashlib.sha256(chunk_bytes).hexdigest()
        if expected_sha256:
            if actual_chunk_sha.lower() != expected_sha256.lower().strip():
                raise ValueError(
                    f"Chunk SHA-256 mismatch for chunk {index}: "
                    f"expected {expected_sha256}, got {actual_chunk_sha}"
                )

        # Idempotent write: write to temp file then replace
        dest_path = self.chunk_file_path(index)
        temp_path = self.chunks_dir / f"{index:06d}.part.tmp"
        with open(temp_path, "wb") as f:
            f.write(chunk_bytes)
        temp_path.replace(dest_path)

        # Record in received list
        if index not in self.meta["received"]:
            self.meta["received"].append(index)
            self.meta["received"].sort()
            self.save_meta()

        return True

    def complete(self):
        """
        Finalizes upload:
        - Verifies all chunks from 0 to totalChunks-1 exist
        - Merges chunks in strict sequential order
        - Verifies merged whole-file SHA-256 against expected fileSha256
        - Updates status to 'complete' or 'checksum_failed'
        """
        self.sync_received_chunks()

        # Check all chunks are present
        received_set = set(self.meta["received"])
        missing = [i for i in range(self.total_chunks) if i not in received_set]
        if missing:
            raise ValueError(f"Cannot complete upload: missing chunks {missing[:10]}...")

        self.files_dir.mkdir(parents=True, exist_ok=True)
        dest_file = self.merged_file_path
        temp_dest = dest_file.with_suffix(".tmp")

        # Merge in order and compute SHA-256 in stream
        hasher = hashlib.sha256()
        with open(temp_dest, "wb") as outfile:
            for i in range(self.total_chunks):
                chunk_file = self.chunk_file_path(i)
                if not chunk_file.exists():
                    if temp_dest.exists():
                        temp_dest.unlink()
                    raise FileNotFoundError(f"Chunk file missing on disk: {chunk_file}")
                with open(chunk_file, "rb") as infile:
                    while True:
                        block = infile.read(64 * 1024)
                        if not block:
                            break
                        outfile.write(block)
                        hasher.update(block)

        merged_sha256 = hasher.hexdigest().lower()

        # Compare checksums
        if merged_sha256 == self.file_sha256.lower():
            temp_dest.replace(dest_file)
            self.meta["status"] = "complete"
            self.meta["mergedSha256"] = merged_sha256
            self.meta["completedAt"] = datetime.now(timezone.utc).isoformat()
            self.save_meta()
            return {
                "status": "complete",
                "sha256": merged_sha256,
                "filePath": str(dest_file),
            }
        else:
            # Checksum failure
            if temp_dest.exists():
                temp_dest.unlink()
            self.meta["status"] = "checksum_failed"
            self.meta["mergedSha256"] = merged_sha256
            self.save_meta()
            return {
                "status": "checksum_failed",
                "expectedSha256": self.file_sha256.lower(),
                "actualSha256": merged_sha256,
            }

    @classmethod
    def list_all(cls, uploads_dir=None, files_dir=None):
        """List all upload sessions for Admin view (S3)."""
        up_dir = Path(uploads_dir) if uploads_dir else UPLOADS_DIR
        f_dir = Path(files_dir) if files_dir else FILES_DIR

        if not up_dir.exists():
            return []

        results = []
        for session_folder in up_dir.iterdir():
            if session_folder.is_dir():
                meta_file = session_folder / "meta.json"
                if meta_file.exists():
                    try:
                        with open(meta_file, "r", encoding="utf-8") as f:
                            meta = json.load(f)
                        # Check disk size of this upload
                        disk_bytes = 0
                        for path in session_folder.rglob("*"):
                            if path.is_file():
                                disk_bytes += path.stat().st_size
                        meta["storageUsed"] = disk_bytes
                        results.append(meta)
                    except Exception:
                        continue

        # Sort by createdAt descending
        results.sort(key=lambda x: x.get("createdAt", ""), reverse=True)
        return results

    @classmethod
    def delete(cls, upload_id, uploads_dir=None, files_dir=None):
        """Deletes upload session directory and any merged file."""
        up_dir = Path(uploads_dir) if uploads_dir else UPLOADS_DIR
        f_dir = Path(files_dir) if files_dir else FILES_DIR

        session_folder = up_dir / upload_id
        deleted = False

        if session_folder.exists():
            shutil.rmtree(session_folder)
            deleted = True

        # Check and remove merged file if present
        if f_dir.exists():
            for item in f_dir.glob(f"{upload_id}_*"):
                try:
                    item.unlink()
                    deleted = True
                except Exception:
                    pass

        return deleted

    @classmethod
    def get_storage_summary(cls, uploads_dir=None, files_dir=None):
        """Calculate total storage used across uploads and merged files."""
        up_dir = Path(uploads_dir) if uploads_dir else UPLOADS_DIR
        f_dir = Path(files_dir) if files_dir else FILES_DIR

        total_bytes = 0
        file_count = 0

        for d in [up_dir, f_dir]:
            if d.exists():
                for item in d.rglob("*"):
                    if item.is_file():
                        total_bytes += item.stat().st_size
                        file_count += 1

        return {
            "totalBytes": total_bytes,
            "totalMB": round(total_bytes / (1024 * 1024), 2),
            "fileCount": file_count,
        }
