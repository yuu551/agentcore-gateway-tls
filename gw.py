"""AgentCore Gateway（private CA対応）の検証用スクリプト。

  uv run gw.py create-gateway
  uv run gw.py create-target <名前> <エンドポイントURL> <s3://... | secret-arn | none>
  uv run gw.py update-target <名前> <エンドポイントURL> <s3://... | secret-arn | none>
  uv run gw.py get-target <名前>
  uv run gw.py tools-list | tools-call <ツール名>
  uv run gw.py cleanup
"""
import json
import sys
import time

import boto3
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

REGION = "ap-northeast-1"

# CloudFormationの出力から、VPCやロールの値を取得する
stack = boto3.client("cloudformation", region_name=REGION).describe_stacks(StackName="GwTlsEc2")["Stacks"][0]
out = {o["OutputKey"]: o["OutputValue"] for o in stack["Outputs"]}
ACCOUNT = boto3.client("sts").get_caller_identity()["Account"]
VPC_ID = out["VpcId"]
SUBNETS = out["SubnetIds"].split(",")
LATTICE_SG = out["LatticeSgId"]
ROLE_ARN = out["GatewayRoleArn"]
STATE = "state.json"

cp = boto3.client("bedrock-agentcore-control", region_name=REGION)


def load():
    try:
        return json.load(open(STATE))
    except FileNotFoundError:
        return {}


def save(s):
    json.dump(s, open(STATE, "w"), indent=2)


def create_gateway():
    gw = cp.create_gateway(
        name="private-tls-demo",
        roleArn=ROLE_ARN,
        protocolType="MCP",
        authorizerType="AWS_IAM",
    )
    while cp.get_gateway(gatewayIdentifier=gw["gatewayId"])["status"] != "READY":
        time.sleep(5)
    save({"gatewayId": gw["gatewayId"], "gatewayUrl": gw["gatewayUrl"], "targets": {}})
    print(gw["gatewayId"], gw["gatewayUrl"])


def certificate_configurations(source):
    if source == "none":
        return None
    if source.startswith("s3://"):
        return [{"s3": {"uri": source, "bucketOwnerAccountId": ACCOUNT}}]
    return [{"secretsManager": {"secretArn": source}}]


def target_params(name, endpoint, source):
    s = load()
    params = dict(
        gatewayIdentifier=s["gatewayId"],
        name=name,
        privateEndpoint={
            "managedVpcResource": {
                "vpcIdentifier": VPC_ID,
                "subnetIds": SUBNETS,
                "endpointIpAddressType": "IPV4",
                "securityGroupIds": [LATTICE_SG],
            }
        },
        targetConfiguration={"mcp": {"mcpServer": {"endpoint": endpoint}}},
    )
    certs = certificate_configurations(source)
    if certs:
        params["certificateConfigurations"] = certs
    return s, params


def create_target(name, endpoint, source):
    s, params = target_params(name, endpoint, source)
    t = cp.create_gateway_target(**params)
    s["targets"][name] = t["targetId"]
    save(s)
    print(t["targetId"], t["status"])


def update_target(name, endpoint, source):
    s, params = target_params(name, endpoint, source)
    t = cp.update_gateway_target(targetId=s["targets"][name], **params)
    print(t["targetId"], t["status"])


def get_target(name, wait=True):
    s = load()
    while True:
        t = cp.get_gateway_target(gatewayIdentifier=s["gatewayId"], targetId=s["targets"][name])
        if not wait or t["status"] not in ("CREATING", "UPDATING", "SYNCHRONIZING"):
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
    # まとめて消すとスロットリングされることがあるので、間隔をあけて削除する
    s = load()
    for t in s.get("targets", {}).values():
        cp.delete_gateway_target(gatewayIdentifier=s["gatewayId"], targetId=t)
        time.sleep(5)
    while cp.list_gateway_targets(gatewayIdentifier=s["gatewayId"])["items"]:
        time.sleep(10)
    cp.delete_gateway(gatewayIdentifier=s["gatewayId"])


if __name__ == "__main__":
    cmd, *a = sys.argv[1:]
    if cmd == "create-gateway":
        create_gateway()
    elif cmd == "create-target":
        create_target(*a)
    elif cmd == "update-target":
        update_target(*a)
    elif cmd == "get-target":
        get_target(*a)
    elif cmd == "tools-list":
        call("tools/list")
    elif cmd == "tools-call":
        call("tools/call", {"name": a[0], "arguments": {}})
    elif cmd == "cleanup":
        cleanup()
