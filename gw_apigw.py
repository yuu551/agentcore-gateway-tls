"""プライベートAPI Gateway（社内CAのカスタムドメイン）をOpenAPIターゲットに登録する検証用スクリプト。

  uv run gw_apigw.py create-gateway
  uv run gw_apigw.py create-target <名前> <with-ca | none>
  uv run gw_apigw.py get-target <名前>
  uv run gw_apigw.py tools-list | tools-call <ツール名>
  uv run gw_apigw.py cleanup
"""
import json
import sys
import time

import boto3
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

REGION = "ap-northeast-1"
DOMAIN = "api.internal.example.com"
STATE = "state-apigw.json"

# CDKの出力から、VPCやロールの値を取得する
stack = boto3.client("cloudformation", region_name=REGION).describe_stacks(StackName="GwTlsApigw")["Stacks"][0]
out = {o["OutputKey"]: o["OutputValue"] for o in stack["Outputs"]}
ACCOUNT = boto3.client("sts").get_caller_identity()["Account"]

cp = boto3.client("bedrock-agentcore-control", region_name=REGION)

# プライベートAPIのOpenAPI定義（serversに社内ドメインを書く）
OPENAPI = {
    "openapi": "3.0.1",
    "info": {"title": "private-api", "version": "1.0"},
    "servers": [{"url": f"https://{DOMAIN}"}],
    "paths": {
        "/hello": {
            "get": {
                "operationId": "getHello",
                "description": "プライベートAPI Gatewayからあいさつを返す",
                "responses": {"200": {"description": "OK"}},
            }
        }
    },
}


def load():
    try:
        return json.load(open(STATE))
    except FileNotFoundError:
        return {}


def save(s):
    json.dump(s, open(STATE, "w"), indent=2)


def create_gateway():
    gw = cp.create_gateway(
        name="private-tls-apigw",
        roleArn=out["GatewayRoleArn"],
        protocolType="MCP",
        authorizerType="AWS_IAM",
    )
    while cp.get_gateway(gatewayIdentifier=gw["gatewayId"])["status"] != "READY":
        time.sleep(5)
    save({"gatewayId": gw["gatewayId"], "gatewayUrl": gw["gatewayUrl"], "targets": {}})
    print(gw["gatewayId"], gw["gatewayUrl"])


def create_target(name, source):
    s = load()
    params = dict(
        gatewayIdentifier=s["gatewayId"],
        name=name,
        privateEndpoint={
            "managedVpcResource": {
                "vpcIdentifier": out["VpcId"],
                "subnetIds": out["SubnetIds"].split(","),
                "endpointIpAddressType": "IPV4",
                "securityGroupIds": [out["LatticeSgId"]],
            }
        },
        targetConfiguration={"mcp": {"openApiSchema": {"inlinePayload": json.dumps(OPENAPI)}}},
    )
    if source == "with-ca":
        params["certificateConfigurations"] = [
            {"s3": {"uri": out["CaPemUri"], "bucketOwnerAccountId": ACCOUNT}}
        ]
    t = cp.create_gateway_target(**params)
    s["targets"][name] = t["targetId"]
    save(s)
    print(t["targetId"], t["status"])


def get_target(name):
    s = load()
    while True:
        t = cp.get_gateway_target(gatewayIdentifier=s["gatewayId"], targetId=s["targets"][name])
        if t["status"] not in ("CREATING", "UPDATING", "SYNCHRONIZING"):
            break
        time.sleep(10)
    t.pop("ResponseMetadata", None)
    print(json.dumps(t, indent=2, default=str, ensure_ascii=False))


def call(method, params=None):
    s = load()
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})
    req = AWSRequest(method="POST", url=s["gatewayUrl"], data=body,
                     headers={"Content-Type": "application/json"})
    SigV4Auth(boto3.Session().get_credentials(), "bedrock-agentcore", REGION).add_auth(req)
    r = requests.post(s["gatewayUrl"], data=body, headers=dict(req.headers), timeout=60)
    print(r.status_code)
    print(json.dumps(r.json(), indent=2, ensure_ascii=False))


def cleanup():
    s = load()
    for t in s.get("targets", {}).values():
        cp.delete_gateway_target(gatewayIdentifier=s["gatewayId"], targetId=t)
        time.sleep(5)
    while cp.list_gateway_targets(gatewayIdentifier=s["gatewayId"])["items"]:
        time.sleep(10)
    cp.delete_gateway(gatewayIdentifier=s["gatewayId"])


if __name__ == "__main__":
    cmd, *a = sys.argv[1:]
    {
        "create-gateway": lambda: create_gateway(),
        "create-target": lambda: create_target(*a),
        "get-target": lambda: get_target(*a),
        "tools-list": lambda: call("tools/list"),
        "tools-call": lambda: call("tools/call", {"name": a[0], "arguments": {}}),
        "cleanup": lambda: cleanup(),
    }[cmd]()
