#!/usr/bin/env python3
"""Dev server for Dungeon Run.

Serves this folder with caching turned off, so every reload, on the Mac or the iPad,
gets the latest code and data. Plain `python3 -m http.server` sends no cache headers,
and browsers then keep stale copies of the JS and CSS for minutes at a time.

    python3 serve.py          then open the printed address on the iPad
    python3 serve.py 8080     same, on another port
"""
import contextlib
import http.server
import socket
import sys
from functools import partial
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = Path(__file__).resolve().parent


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class DualStackServer(http.server.ThreadingHTTPServer):
    """Listens on IPv4 and IPv6, so both localhost and the iPad's address work."""

    address_family = socket.AF_INET6

    def server_bind(self):
        with contextlib.suppress(Exception):
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        return super().server_bind()


def lan_address():
    """This Mac's address on the local network, to type into the iPad."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        try:
            probe.connect(("10.255.255.255", 1))  # sends nothing; only picks the outgoing interface
            return probe.getsockname()[0]
        except OSError:
            return "localhost"


if __name__ == "__main__":
    handler = partial(NoCacheHandler, directory=str(ROOT))
    with DualStackServer(("::", PORT), handler) as server:
        print("Dungeon Run, served with caching off.")
        print(f"  On this Mac:  http://localhost:{PORT}")
        print(f"  On the iPad:  http://{lan_address()}:{PORT}   (same Wi-Fi)")
        print("Ctrl-C to stop.")
        with contextlib.suppress(KeyboardInterrupt):
            server.serve_forever()
