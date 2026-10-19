# agentcore-gateway-tls

Amazon Bedrock AgentCore Gateway のプライベート CA 対応（`certificateConfigurations`）を検証したコードです。社内 CA で署名した証明書を使う VPC 内のサーバーに、Gateway から VPC Lattice 経由で接続します。

- 本編：EC2 上の MCP サーバー（`mcp.internal.example.com`）を MCP サーバーターゲットとして登録
- おまけ：プライベートな API Gateway のカスタムドメイン（`api.internal.example.com`）を OpenAPI ターゲットとして登録

## 構成

| パス | 内容 |
| --- | --- |
| `certs.sh` | 検証用の社内 CA とサーバー証明書を `certs/` に作る |
| `server.py` | EC2 で動かす MCP サーバー（HTTPS 443） |
| `openapi/private-api.json` | おまけの OpenAPI ターゲットに渡す API 定義 |
| `cdk/` | AWS CDK アプリ。`GwTlsEc2`（本編）と `GwTlsApigw`（おまけ）の 2 スタック。Gateway 本体まで作る |

CloudFormation の `AWS::BedrockAgentCore::GatewayTarget` がまだ `CertificateConfigurations` に対応していないため、ターゲットは AWS CLI で登録します。

## 前提

- リージョン：ap-northeast-1（CDK ブートストラップ済み）
- Node.js + pnpm
- AWS CLI 2.37.13 以降（`--certificate-configurations` 対応版）
- curl（`--aws-sigv4` 対応版）

## 使い方（本編）

```bash
(cd cdk && pnpm install)
./certs.sh
(cd cdk && pnpm cdk deploy GwTlsEc2)

out() { aws cloudformation describe-stacks --region ap-northeast-1 --stack-name GwTlsEc2 \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
GW_ID=$(out GatewayId); GW_URL=$(out GatewayUrl); PE=$(out PrivateEndpoint); B=$(out BucketName)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

# ターゲットの登録（社内 CA の PEM を指定）
aws bedrock-agentcore-control create-gateway-target --region ap-northeast-1 \
  --gateway-identifier "$GW_ID" --name with-ca \
  --target-configuration '{"mcp": {"mcpServer": {"endpoint": "https://mcp.internal.example.com/mcp"}}}' \
  --private-endpoint "$PE" \
  --certificate-configurations "[{\"s3\": {\"uri\": \"s3://$B/ca/private-ca.pem\", \"bucketOwnerAccountId\": \"$ACCOUNT\"}}]"

# READY になったらツールを呼び出す
eval "$(aws configure export-credentials --format env)"
curl -s "$GW_URL" --aws-sigv4 "aws:amz:ap-northeast-1:bedrock-agentcore" \
  --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" -H "x-amz-security-token: $AWS_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "with-ca___whoami", "arguments": {}}}'

# 後片付け（ターゲット → スタックの順）
for t in $(aws bedrock-agentcore-control list-gateway-targets --region ap-northeast-1 \
    --gateway-identifier "$GW_ID" --query 'items[].targetId' --output text); do
  aws bedrock-agentcore-control delete-gateway-target --region ap-northeast-1 --gateway-identifier "$GW_ID" --target-id "$t"; sleep 5
done
(cd cdk && pnpm cdk destroy GwTlsEc2)
```

## 使い方（おまけ：プライベート API Gateway）

```bash
CERT_ARN=$(aws acm import-certificate --region ap-northeast-1 \
  --certificate fileb://certs/api.pem --private-key fileb://certs/api.key \
  --certificate-chain fileb://certs/ca.pem --query CertificateArn --output text)
(cd cdk && pnpm cdk deploy GwTlsApigw -c certificateArn=$CERT_ARN)

out() { aws cloudformation describe-stacks --region ap-northeast-1 --stack-name GwTlsApigw \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
GW_ID=$(out GatewayId); GW_URL=$(out GatewayUrl); PE=$(out PrivateEndpoint); B=$(out BucketName)

aws bedrock-agentcore-control create-gateway-target --region ap-northeast-1 \
  --gateway-identifier "$GW_ID" --name with-ca \
  --target-configuration "{\"mcp\": {\"openApiSchema\": {\"s3\": {\"uri\": \"s3://$B/openapi/private-api.json\"}}}}" \
  --private-endpoint "$PE" \
  --certificate-configurations "[{\"s3\": {\"uri\": \"s3://$B/ca/ca.pem\", \"bucketOwnerAccountId\": \"$ACCOUNT\"}}]"

# ツールの呼び出しは本編と同じ curl で、ツール名を with-ca___getHello にする

# 後片付け：ターゲットを削除してから
(cd cdk && pnpm cdk destroy GwTlsApigw -c certificateArn=$CERT_ARN)
aws acm delete-certificate --region ap-northeast-1 --certificate-arn $CERT_ARN
```

## 注意

検証用のコードです。サーバー証明書の秘密鍵を S3 経由で EC2 に渡しているなど、本番での利用は想定していません。
