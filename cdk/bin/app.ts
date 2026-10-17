#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { Ec2Stack } from '../lib/ec2-stack';
import { ApigwStack } from '../lib/apigw-stack';

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-northeast-1' };

// 本編：社内CAの証明書を使うMCPサーバー（EC2）
new Ec2Stack(app, 'GwTlsEc2', { env });

// おまけ：社内CAの証明書を付けたプライベートAPI Gateway
// ACMにインポートした証明書のARNを渡したときだけ作る（cdk deploy GwTlsApigw -c certificateArn=...）
const certificateArn = app.node.tryGetContext('certificateArn');
if (certificateArn) {
  new ApigwStack(app, 'GwTlsApigw', { env, certificateArn });
}
