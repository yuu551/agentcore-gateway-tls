import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

const CERTS = path.join(__dirname, '../../certs');
const read = (name: string) => fs.readFileSync(path.join(CERTS, name), 'utf8');

export class Ec2Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // パブリックサブネット（NAT用）と、MCPサーバーを置くプライベートサブネット
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // Gateway（VPC Lattice）が作るENIに付けるSG
    const latticeSg = new ec2.SecurityGroup(this, 'LatticeSg', { vpc, allowAllOutbound: true });

    // MCPサーバーは、リソースゲートウェイのENIからの443だけを受け付ける
    const serverSg = new ec2.SecurityGroup(this, 'ServerSg', { vpc, allowAllOutbound: true });
    serverSg.addIngressRule(latticeSg, ec2.Port.tcp(443));

    // サーバー証明書・MCPサーバーのコードと、Gatewayが参照するCA証明書のPEM
    const bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const serverFiles = new s3deploy.BucketDeployment(this, 'ServerFiles', {
      destinationBucket: bucket,
      destinationKeyPrefix: 'server',
      sources: [
        s3deploy.Source.data('server.pem', read('server.pem')),
        s3deploy.Source.data('server.key', read('server.key')),
        s3deploy.Source.asset(path.join(__dirname, '../..'), { exclude: ['*', '!server.py'] }),
      ],
    });
    // Gatewayが参照するCA証明書のPEM
    new s3deploy.BucketDeployment(this, 'CaFiles', {
      destinationBucket: bucket,
      destinationKeyPrefix: 'ca',
      sources: [s3deploy.Source.data('private-ca.pem', read('ca.pem'))],
    });

    // MCPサーバー（起動時にS3から証明書とコードを取得し、systemdで起動する）
    const role = new iam.Role(this, 'ServerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    bucket.grantRead(role, 'server/*');
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      'mkdir -p /opt/mcp && cd /opt/mcp',
      `aws s3 cp s3://${bucket.bucketName}/server/ . --recursive`,
      'chmod 600 server.key',
      'export HOME=/root',
      'curl -LsSf https://astral.sh/uv/0.9.26/install.sh | sh',
      `cat > /etc/systemd/system/mcp.service <<'UNIT'
[Unit]
Description=Private MCP server
After=network-online.target
[Service]
WorkingDirectory=/opt/mcp
Environment=HOME=/root
ExecStart=/root/.local/bin/uv run server.py
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT`,
      'systemctl daemon-reload',
      'systemctl enable --now mcp',
    );
    const server = new ec2.Instance(this, 'Server', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, availabilityZones: [vpc.availabilityZones[0]] },
      instanceType: new ec2.InstanceType('t4g.small'),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
      securityGroup: serverSg,
      role,
      userData,
    });
    server.node.addDependency(serverFiles);

    // VPC内だけで引ける社内ドメイン
    const zone = new route53.PrivateHostedZone(this, 'Zone', { zoneName: 'internal.example.com', vpc });
    new route53.ARecord(this, 'McpRecord', {
      zone,
      recordName: 'mcp',
      target: route53.RecordTarget.fromIpAddresses(server.instancePrivateIp),
      ttl: cdk.Duration.seconds(60),
    });

    // Gatewayのサービスロール（CA証明書の読み取り）
    const gatewayRole = new iam.Role(this, 'GatewayRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*` },
        },
      }),
    });
    bucket.grantRead(gatewayRole, 'ca/*');
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:gw-tls-demo-ca-*`],
      }),
    );

    // IAM認証のMCPゲートウェイ（ターゲットはCLIで登録する）
    const gateway = new agentcore.CfnGateway(this, 'Gateway', {
      name: 'private-tls-demo',
      protocolType: 'MCP',
      authorizerType: 'AWS_IAM',
      roleArn: gatewayRole.roleArn,
    });

    // ターゲット登録時に --private-endpoint へそのまま渡すJSON
    const privateEndpoint = {
      managedVpcResource: {
        vpcIdentifier: vpc.vpcId,
        subnetIds: vpc.privateSubnets.map((s) => s.subnetId),
        endpointIpAddressType: 'IPV4',
        securityGroupIds: [latticeSg.securityGroupId],
      },
    };

    new cdk.CfnOutput(this, 'GatewayId', { value: gateway.attrGatewayIdentifier });
    new cdk.CfnOutput(this, 'GatewayUrl', { value: gateway.attrGatewayUrl });
    new cdk.CfnOutput(this, 'PrivateEndpoint', { value: this.toJsonString(privateEndpoint) });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'ServerInstanceId', { value: server.instanceId });
  }
}
