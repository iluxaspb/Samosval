#!/usr/bin/env python3
"""
Lightweight Static + OpenCode IPC Bridge Server for Samosval Test Environment.
Serves static files like http.server, plus provides bidirectional /api/opencode-bridge
endpoints for PWA <-> OpenCode communication.
"""

import os
import sys
import json
import time
import subprocess
from http.server import HTTPServer, SimpleHTTPRequestHandler

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4173
PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OPENCODE_DIR = os.path.join(PROJECT_DIR, ".opencode-project")
MISSIONS_FILE = os.path.join(OPENCODE_DIR, "AI_MISSIONS.json")
INBOX_FILE = os.path.join(OPENCODE_DIR, "AI_INBOX.json")
REPLIES_FILE = os.path.join(OPENCODE_DIR, "AI_REPLIES.json")

os.makedirs(OPENCODE_DIR, exist_ok=True)

class OpenCodeBridgeHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        url_path = self.path.split("?")[0]

        if url_path == "/api/opencode-bridge/status":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()

            branch = "unknown"
            try:
                branch = subprocess.check_output(["git", "branch", "--show-current"], cwd=PROJECT_DIR, text=True).strip()
            except Exception:
                pass

            data = {
                "ok": True,
                "connected": True,
                "server": "OpenCode Container Bridge v1.0",
                "gitBranch": branch,
                "missionsCount": self._count_items(MISSIONS_FILE),
                "inboxCount": self._count_items(INBOX_FILE),
                "repliesCount": self._count_items(REPLIES_FILE)
            }
            self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))
            return

        elif url_path == "/api/opencode-bridge/inbox":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()

            inbox_data = {"messages": []}
            if os.path.exists(INBOX_FILE):
                try:
                    with open(INBOX_FILE, "r", encoding="utf-8") as f:
                        inbox_data = json.load(f)
                except Exception as e:
                    inbox_data = {"messages": [], "error": str(e)}

            self.wfile.write(json.dumps(inbox_data, ensure_ascii=False).encode("utf-8"))
            return

        elif url_path == "/api/opencode-bridge/missions":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()

            missions_data = {"missions": []}
            if os.path.exists(MISSIONS_FILE):
                try:
                    with open(MISSIONS_FILE, "r", encoding="utf-8") as f:
                        missions_data = json.load(f)
                except Exception as e:
                    missions_data = {"missions": [], "error": str(e)}

            self.wfile.write(json.dumps(missions_data, ensure_ascii=False).encode("utf-8"))
            return

        super().do_GET()

    def do_POST(self):
        url_path = self.path.split("?")[0]

        if url_path == "/api/opencode-bridge/mission":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8")
            try:
                payload = json.loads(body)
                current = {"missions": []}
                if os.path.exists(MISSIONS_FILE):
                    try:
                        with open(MISSIONS_FILE, "r", encoding="utf-8") as f:
                            current = json.load(f)
                    except Exception:
                        current = {"missions": []}

                if "missions" not in current:
                    current["missions"] = []

                payload["receivedAt"] = int(time.time() * 1000)
                current["missions"].append(payload)

                with open(MISSIONS_FILE, "w", encoding="utf-8") as f:
                    json.dump(current, f, ensure_ascii=False, indent=2)

                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                resp = {"ok": True, "message": "Миссия успешно передана ИИ-разработчику OpenCode", "id": payload.get("id")}
                self.wfile.write(json.dumps(resp, ensure_ascii=False).encode("utf-8"))
            except Exception as e:
                self.send_response(400)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False).encode("utf-8"))
            return

        elif url_path == "/api/opencode-bridge/reply":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8")
            try:
                payload = json.loads(body)
                replies = {"replies": []}
                if os.path.exists(REPLIES_FILE):
                    try:
                        with open(REPLIES_FILE, "r", encoding="utf-8") as f:
                            replies = json.load(f)
                    except Exception:
                        replies = {"replies": []}

                if "replies" not in replies:
                    replies["replies"] = []

                replies["replies"].append(payload)

                with open(REPLIES_FILE, "w", encoding="utf-8") as f:
                    json.dump(replies, f, ensure_ascii=False, indent=2)

                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True, "message": "Ответ администратора зафиксирован"}, ensure_ascii=False).encode("utf-8"))
            except Exception as e:
                self.send_response(400)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False).encode("utf-8"))
            return

        self.send_response(404)
        self.end_headers()

    def _count_items(self, path):
        if not os.path.exists(path):
            return 0
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    for v in data.values():
                        if isinstance(v, list):
                            return len(v)
                elif isinstance(data, list):
                    return len(data)
        except Exception:
            return 0
        return 0

def run():
    os.chdir(PROJECT_DIR)
    server_address = ("0.0.0.0", PORT)
    httpd = HTTPServer(server_address, OpenCodeBridgeHandler)
    print(f"Samosval OpenCode Bridge & Static Server running on http://0.0.0.0:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    run()
