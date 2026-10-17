# agentcore-gateway-tls

Amazon Bedrock AgentCore Gateway のプライベート CA 対応（`certificateConfigurations`）を検証したコードです。社内 CA で署名した証明書を使う VPC 内のサーバーに、Gateway から VPC Lattice 経由で接続します。

- 本編：EC2 上の MCP サーバー（`mcp.internal.example.com`）を MCP サーバーターゲットとして登録
- おまけ：プライベートな API Gateway のカスタムドメイン（`api.internal.example.com`）を OpenAPI ターゲットとして登録

## 構成

| パス | 内容 |
| --- | --- |
| `certs.sh` | 検証用の社内 CA・サーバー証明書・失敗ケース用の証明書を `certs/` に作る |
| `server.py` | EC2 で動かす MCP サーバー（HTTPS 443） |
| `cdk/` | AWS CDK アプリ。`GwTlsEc2`（本編）と `GwTlsApigw`（おまけ）の 2 スタック |
| `gw.py` | 本編の Gateway・ターゲットを boto3 で操作する |
| `gw_apigw.py` | おまけの Gateway・ターゲットを boto3 で操作する |

CDK の `CfnGatewayTarget`（aws-cdk-lib 2.273.0）にはまだ `certificateConfigurations` がないため、Gateway とターゲットは boto3 で作ります。

## 前提

- リージョン：ap-northeast-1（CDK ブートストラップ済み）
- Python 3.12 + uv、boto3 1.43.108 以降
- Node.js + pnpm
- OpenSSL 3.4 以降（期限切れ CA の作成に `-not_before` / `-not_after` を使う）

## 使い方（本編）

```bash
uv sync
(cd cdk && pnpm install)
./certs.sh

# VPC・EC2・プライベートホストゾーン・S3・Gateway のロールを作る
(cd cdk && pnpm cdk deploy GwTlsEc2)
B=$(aws cloudformation describe-stacks --region ap-northeast-1 --stack-name GwTlsEc2 \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text)

uv run gw.py create-gateway
uv run gw.py create-target with-ca https://mcp.internal.example.com/mcp s3://$B/ca/private-ca.pem
uv run gw.py get-target with-ca
uv run gw.py tools-call with-ca___whoami

# 後片付け
uv run gw.py cleanup
(cd cdk && pnpm cdk destroy GwTlsEc2)
```

## 使い方（おまけ：プライベート API Gateway）

```bash
CERT_ARN=$(aws acm import-certificate --region ap-northeast-1 \
  --certificate fileb://certs/api.pem --private-key fileb://certs/api.key \
  --certificate-chain fileb://certs/ca.pem --query CertificateArn --output text)
(cd cdk && pnpm cdk deploy GwTlsApigw -c certificateArn=$CERT_ARN)

uv run gw_apigw.py create-gateway
uv run gw_apigw.py create-target with-ca with-ca
uv run gw_apigw.py tools-call with-ca___getHello

# 後片付け
uv run gw_apigw.py cleanup
(cd cdk && pnpm cdk destroy GwTlsApigw -c certificateArn=$CERT_ARN)
aws acm delete-certificate --region ap-northeast-1 --certificate-arn $CERT_ARN
```

## 注意

検証用のコードです。サーバー証明書の秘密鍵を S3 経由で EC2 に渡しているなど、本番での利用は想定していません。
