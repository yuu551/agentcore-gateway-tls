#!/usr/bin/env bash
# 検証用の証明書を certs/ に作る（OpenSSL 3.x）
set -euo pipefail
HOST=mcp.internal.example.com
mkdir -p certs && cd certs

# 社内CA：basicConstraintsをCA:TRUEにして自己署名する
openssl genrsa -out ca.key 2048
openssl req -x509 -new -key ca.key -sha256 -days 3650 \
  -subj "/CN=Demo Private CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -out ca.pem

# サーバー証明書：SANに接続先ホスト名を入れ、CAで署名する
openssl genrsa -out server.key 2048
openssl req -new -key server.key -subj "/CN=$HOST" -out server.csr
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -days 365 -sha256 \
  -extfile <(printf "subjectAltName=DNS:%s\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n" "$HOST") \
  -out server.pem

# ---- 失敗ケースの確認用 ----
# 別のCA（server.pemを署名していないCA）
openssl genrsa -out other.key 2048
openssl req -x509 -new -key other.key -sha256 -days 3650 \
  -subj "/CN=Other Private CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -out other-ca.pem

# 有効期限が2025年1月に切れているCA（-not_before / -not_after は OpenSSL 3.4 以降）
openssl genrsa -out expired.key 2048
openssl req -x509 -new -key expired.key -sha256 \
  -not_before 20250101000000Z -not_after 20250102000000Z \
  -subj "/CN=Expired Private CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -out expired-ca.pem

# ---- おまけ：プライベートAPI Gatewayのカスタムドメイン用 ----
API_HOST=api.internal.example.com
openssl genrsa -out api.key 2048
openssl req -new -key api.key -subj "/CN=$API_HOST" -out api.csr
openssl x509 -req -in api.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -days 365 -sha256 \
  -extfile <(printf "subjectAltName=DNS:%s\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\n" "$API_HOST") \
  -out api.pem
