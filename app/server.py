import os
import random
from pathlib import Path
from flask import Flask, request, jsonify, render_template, send_from_directory, abort
from app.session import UploadSession, DEFAULT_CHUNK_SIZE, MAX_FILE_SIZE, FILES_DIR

app = Flask(__name__, template_folder="templates", static_folder="static")

@app.after_request
def add_cors_headers(response):
    """Enable CORS so a standalone frontend (e.g. on friend's repo/port) can communicate with backend."""
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Chunk-SHA256, X-Role"
    return response


@app.route("/api/<path:path>", methods=["OPTIONS"])
def handle_options(path):
    """Handle pre-flight CORS requests."""
    return "", 204

# Flaky network simulation state for Test Lab (0 to 50% failure rate, kill connection at %)
flaky_config = {
    "fail_rate": 0,           # 0 means normal operation, e.g. 20 means 20% failure rate
    "kill_at_percent": 0,     # e.g., 0 (disabled), 25, 50, 75%
    "killed_sessions": set(), # tracks uploadIds that were already severed once at threshold
}


@app.route("/")
def index():
    """Serves the main application UI."""
    return render_template("index.html")


@app.route("/api/health", methods=["GET"])
def health_check():
    """Service health check."""
    return jsonify({"status": "ok", "service": "Resumable/Chunked Upload Service", "version": "1.0.0"})


@app.route("/api/uploads", methods=["POST"])
def create_upload():
    """
    POST /api/uploads
    Create a new upload session.
    Input JSON: { fileName, size, chunkSize, totalChunks, fileSha256 }
    Output JSON: { uploadId }
    """
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Invalid JSON body"}), 400

    file_name = data.get("fileName")
    size = data.get("size")
    chunk_size = data.get("chunkSize", DEFAULT_CHUNK_SIZE)
    total_chunks = data.get("totalChunks")
    file_sha256 = data.get("fileSha256", "")

    try:
        session = UploadSession.create(
            file_name=file_name,
            size=size,
            chunk_size=chunk_size,
            total_chunks=total_chunks,
            file_sha256=file_sha256,
        )
        return jsonify({"uploadId": session.upload_id}), 201
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"Server error creating upload: {str(e)}"}), 500


@app.route("/api/uploads/<upload_id>", methods=["GET"])
def get_upload(upload_id):
    """
    GET /api/uploads/<uploadId>
    Return upload session status and received chunk indexes.
    Output JSON: { uploadId, fileName, size, chunkSize, totalChunks, fileSha256, received: [...], status }
    """
    session = UploadSession.get(upload_id)
    if not session:
        return jsonify({"error": f"Upload session '{upload_id}' not found."}), 404

    return jsonify({
        "uploadId": session.upload_id,
        "fileName": session.file_name,
        "originalFileName": session.original_file_name,
        "size": session.size,
        "chunkSize": session.chunk_size,
        "totalChunks": session.total_chunks,
        "fileSha256": session.file_sha256,
        "received": session.received,
        "status": session.status,
        "createdAt": session.meta.get("createdAt"),
        "updatedAt": session.meta.get("updatedAt"),
        "mergedSha256": session.meta.get("mergedSha256"),
    }), 200


@app.route("/api/uploads/<upload_id>/chunks/<int:chunk_index>", methods=["PUT"])
def upload_chunk(upload_id, chunk_index):
    """
    PUT /api/uploads/<uploadId>/chunks/<index>
    Receive raw chunk bytes and X-Chunk-SHA256 header.
    Verify and save chunk idempotently.
    """
    session = UploadSession.get(upload_id)
    if not session:
        return jsonify({"error": f"Upload session '{upload_id}' not found."}), 404

    # Check simulated connection kill at specific progress percentage (PRD Page 3 & 6: "Kill connection at 50%")
    kill_at = flaky_config.get("kill_at_percent", 0)
    if kill_at > 0 and upload_id not in flaky_config.get("killed_sessions", set()):
        progress_pct = int(((chunk_index + 1) / session.total_chunks) * 100)
        if progress_pct >= kill_at:
            flaky_config.setdefault("killed_sessions", set()).add(upload_id)
            return jsonify({
                "error": f"Simulated connection severed at {progress_pct}% (Kill rule: {kill_at}%)"
            }), 503

    # Check simulated flaky test failure (0 to 50%)
    fail_rate = flaky_config.get("fail_rate", 0)
    if fail_rate > 0:
        roll = random.uniform(0, 100)
        if roll < fail_rate:
            return jsonify({
                "error": f"Simulated network drop ({fail_rate}% flaky failure active)"
            }), 500

    expected_chunk_sha = request.headers.get("X-Chunk-SHA256")
    chunk_bytes = request.get_data()

    if not chunk_bytes:
        return jsonify({"error": "Empty chunk body received."}), 400

    try:
        session.save_chunk(
            index=chunk_index,
            chunk_bytes=chunk_bytes,
            expected_sha256=expected_chunk_sha,
        )
        return jsonify({
            "message": "saved",
            "index": chunk_index,
            "received": session.received,
            "receivedCount": len(session.received),
            "totalChunks": session.total_chunks,
        }), 200
    except ValueError as e:
        # Check if hash mismatch
        if "SHA-256 mismatch" in str(e):
            return jsonify({"error": str(e), "chunkIndex": chunk_index}), 409
        return jsonify({"error": str(e)}), 400
    except IndexError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"Failed to save chunk: {str(e)}"}), 500


@app.route("/api/uploads/<upload_id>/complete", methods=["POST"])
def complete_upload(upload_id):
    """
    POST /api/uploads/<uploadId>/complete
    Require all chunks, merge in order, calculate final SHA-256,
    and return complete or checksum_failed.
    """
    session = UploadSession.get(upload_id)
    if not session:
        return jsonify({"error": f"Upload session '{upload_id}' not found."}), 404

    try:
        result = session.complete()
        if result["status"] == "complete":
            return jsonify({
                "status": "complete",
                "uploadId": session.upload_id,
                "fileName": session.original_file_name,
                "sha256": result["sha256"],
                "downloadUrl": f"/api/files/{session.upload_id}",
                "message": "Upload complete · checksum verified ✓"
            }), 200
        else:
            return jsonify({
                "status": "checksum_failed",
                "uploadId": session.upload_id,
                "error": "Checksum verification failed: merged file does not match expected SHA-256.",
                "expectedSha256": result.get("expectedSha256"),
                "actualSha256": result.get("actualSha256"),
            }), 400
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"Error merging upload: {str(e)}"}), 500


@app.route("/api/files/<upload_id>", methods=["GET"])
def download_file(upload_id):
    """
    GET /api/files/<uploadId>
    Serve a completed file for download.
    """
    session = UploadSession.get(upload_id)
    if not session:
        abort(404, description="Upload not found.")

    if session.status != "complete":
        abort(400, description="File upload is not complete.")

    merged_path = session.merged_file_path
    if not merged_path.exists():
        abort(404, description="Merged file not found on disk.")

    return send_from_directory(
        directory=merged_path.parent,
        path=merged_path.name,
        as_attachment=True,
        download_name=session.original_file_name,
    )


# --- Admin & Test Lab Endpoints ---

@app.route("/api/admin/uploads", methods=["GET"])
def admin_list_uploads():
    """
    GET /api/admin/uploads
    Header X-Role: admin
    List all uploads on server with sizes, chunks, checksum status, and storage summary.
    """
    role = request.headers.get("X-Role", "")
    if role != "admin":
        return jsonify({"error": "Admin role required (provide 'X-Role: admin' header)."}), 403

    uploads = UploadSession.list_all()
    storage = UploadSession.get_storage_summary()
    return jsonify({
        "uploads": uploads,
        "storage": storage,
    }), 200


@app.route("/api/admin/uploads/<upload_id>", methods=["DELETE"])
def admin_delete_upload(upload_id):
    """
    DELETE /api/admin/uploads/<uploadId>
    Header X-Role: admin
    Delete an upload and its files.
    """
    role = request.headers.get("X-Role", "")
    if role != "admin":
        return jsonify({"error": "Admin role required (provide 'X-Role: admin' header)."}), 403

    deleted = UploadSession.delete(upload_id)
    if not deleted:
        return jsonify({"error": f"Upload '{upload_id}' not found or already deleted."}), 404

    return jsonify({"message": f"Deleted {upload_id}", "uploadId": upload_id}), 200


@app.route("/api/test/flaky", methods=["GET", "POST"])
def configure_flaky_test():
    """
    GET /api/test/flaky?fail=20&kill_at=50
    Configure or inspect simulated network failure rate (0 to 50%) and connection drop at progress %.
    """
    fail_param = request.args.get("fail")
    kill_param = request.args.get("kill_at")
    reset_param = request.args.get("reset_killed")

    if reset_param:
        flaky_config.setdefault("killed_sessions", set()).clear()

    if fail_param is not None:
        try:
            rate = int(fail_param)
            if rate < 0 or rate > 50:
                return jsonify({"error": "fail rate must be between 0 and 50%"}), 400
            flaky_config["fail_rate"] = rate
        except ValueError:
            return jsonify({"error": "Invalid fail rate parameter."}), 400

    if kill_param is not None:
        try:
            kill_val = int(kill_param)
            if kill_val < 0 or kill_val > 100:
                return jsonify({"error": "kill_at must be between 0 and 100%"}), 400
            flaky_config["kill_at_percent"] = kill_val
            flaky_config.setdefault("killed_sessions", set()).clear()
        except ValueError:
            return jsonify({"error": "Invalid kill_at parameter."}), 400

    return jsonify({
        "flakyFailRate": flaky_config["fail_rate"],
        "killAtPercent": flaky_config.get("kill_at_percent", 0),
        "description": "Simulates random chunk failures (0-50%) and connection drop at chosen %.",
    }), 200


if __name__ == "__main__":
    # Create required storage directories
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    app.run(host="0.0.0.0", port=5000, debug=True)
