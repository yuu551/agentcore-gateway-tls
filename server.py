# /// script
# requires-python = ">=3.14,<3.15"
# dependencies = ["mcp==1.30.0"]
# ///
import os
import socket

import uvicorn
from mcp.server.fastmcp import FastMCP

# 0.0.0.0 を指定すると、Hostヘッダーの制限（DNSリバインディング対策）が自動では有効にならない
mcp = FastMCP("private-tls-demo", host="0.0.0.0", stateless_http=True, json_response=True)


@mcp.tool()
def whoami() -> str:
    """このMCPサーバーが動いているホスト名を返す"""
    return f"hello from {socket.gethostname()}"


if __name__ == "__main__":
    uvicorn.run(
        mcp.streamable_http_app(),
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "443")),
        ssl_certfile=os.environ.get("CERT", "server.pem"),
        ssl_keyfile=os.environ.get("KEY", "server.key"),
    )
