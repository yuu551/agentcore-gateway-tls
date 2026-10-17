import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

export interface ApigwStackProps extends cdk.StackProps {
  certificateArn: string;
}

const DOMAIN = 'api.internal.example.com';

export class ApigwStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApigwStackProps) {
    super(scope, id, props);

    // NATなしのプライベートサブネットだけのVPC
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.1.0.0/16'),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
    });

    // Gateway（VPC Lattice）が作るENIに付けるSG
    const latticeSg = new ec2.SecurityGroup(this, 'LatticeSg', { vpc, allowAllOutbound: true });

    // execute-apiのVPCエンドポイントは、リソースゲートウェイのENIからの443だけを受け付ける
    const vpceSg = new ec2.SecurityGroup(this, 'VpceSg', { vpc, allowAllOutbound: false });
    vpceSg.addIngressRule(latticeSg, ec2.Port.tcp(443));
    const vpce = vpc.addInterfaceEndpoint('ExecuteApi', {
      service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
      privateDnsEnabled: false,
      securityGroups: [vpceSg],
      open: false,
    });

    // VPCエンドポイント経由の呼び出しだけを許可するポリシー
    const fromVpce = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          principals: [new iam.AnyPrincipal()],
          actions: ['execute-api:Invoke'],
          resources: ['execute-api:/*'],
          conditions: { StringEquals: { 'aws:SourceVpce': vpce.vpcEndpointId } },
        }),
      ],
    });

    // Mock統合でJSONを返すだけのプライベートAPI
    const api = new apigw.RestApi(this, 'Api', {
      restApiName: 'gw-tls-private-api',
      endpointTypes: [apigw.EndpointType.PRIVATE],
      policy: fromVpce,
      deployOptions: { stageName: 'prod' },
    });
    api.root.addResource('hello').addMethod(
      'GET',
      new apigw.MockIntegration({
        requestTemplates: { 'application/json': '{"statusCode": 200}' },
        integrationResponses: [
          {
            statusCode: '200',
            responseTemplates: { 'application/json': '{"message": "hello from private API Gateway"}' },
          },
        ],
      }),
      { methodResponses: [{ statusCode: '200' }] },
    );

    // 社内CAで署名した証明書を付けたプライベートなカスタムドメイン
    const domain = new apigw.CfnDomainNameV2(this, 'PrivateDomain', {
      domainName: DOMAIN,
      certificateArn: props.certificateArn,
      endpointConfiguration: { types: ['PRIVATE'] },
      securityPolicy: 'TLS_1_2',
      policy: fromVpce.toJSON(),
    });
    new apigw.CfnBasePathMappingV2(this, 'Mapping', {
      domainNameArn: domain.attrDomainNameArn,
      restApiId: api.restApiId,
      stage: api.deploymentStage.stageName,
    });
    new apigw.CfnDomainNameAccessAssociation(this, 'AccessAssociation', {
      domainNameArn: domain.attrDomainNameArn,
      accessAssociationSource: vpce.vpcEndpointId,
      accessAssociationSourceType: 'VPCE',
    });

    // VPC内だけで引ける社内ドメインを、VPCエンドポイントに向ける
    const zone = new route53.PrivateHostedZone(this, 'Zone', { zoneName: 'internal.example.com', vpc });
    new route53.ARecord(this, 'ApiRecord', {
      zone,
      recordName: DOMAIN,
      target: route53.RecordTarget.fromAlias(new targets.InterfaceVpcEndpointTarget(vpce)),
    });

    // Gatewayが参照するCA証明書のPEM
    const bucket = new s3.Bucket(this, 'CaBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    new s3deploy.BucketDeployment(this, 'CaPem', {
      destinationBucket: bucket,
      destinationKeyPrefix: 'ca',
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../certs'), { exclude: ['*', '!ca.pem'] })],
    });

    // Gatewayのサービスロール（CA証明書の読み取りだけ）
    const gatewayRole = new iam.Role(this, 'GatewayRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*` },
        },
      }),
    });
    bucket.grantRead(gatewayRole, 'ca/*');

    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    new cdk.CfnOutput(this, 'SubnetIds', { value: vpc.isolatedSubnets.map((s) => s.subnetId).join(',') });
    new cdk.CfnOutput(this, 'LatticeSgId', { value: latticeSg.securityGroupId });
    new cdk.CfnOutput(this, 'GatewayRoleArn', { value: gatewayRole.roleArn });
    new cdk.CfnOutput(this, 'CaPemUri', { value: `s3://${bucket.bucketName}/ca/ca.pem` });
  }
}
