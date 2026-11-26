#!/usr/bin/env python3
"""
Entry point to run the Resumable/Chunked Upload Service Flask server.
"""
import sys
import os
from pathlib import Path

# Ensure root directory is in sys.path
root_dir = Path(__file__).resolve().parent
if str(root_dir) not in sys.path:
    sys.path.insert(0, str(root_dir))

from app.server import app
from app.session import FILES_DIR, UPLOADS_DIR

if __name__ == "__main__":
    # Ensure storage directories exist
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

    port = int(os.environ.get("PORT", 5050))
    print(f"Starting Resumable/Chunked Upload Service on http://0.0.0.0:{port}")
    print(f"Storage path: {root_dir / 'storage'}")
    app.run(host="0.0.0.0", port=port, debug=True)
