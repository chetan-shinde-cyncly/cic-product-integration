#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { loadConfig } from "../lib/config";
import { FrontendStack } from "../lib/frontend-stack";

const app = new cdk.App();
const envName = app.node.tryGetContext("env") || "dev";
const config = loadConfig(envName);
const stackName = `${config.stackPrefix}Stack`;

console.log(`Deploying CIC frontend to ${envName}.`);
console.log(`Stack: ${stackName}; domain: ${config.domainName}`);

new FrontendStack(app, stackName, {
  env: { account: config.account, region: config.region },
  nodeEnv: config.nodeEnv,
  domainName: config.domainName,
  hostedZoneName: config.hostedZoneName,
  certificateArn: config.certificateArn,
  frontendBuildPath: config.frontendBuildPath,
  hostedZoneId: config.hostedZoneId,
});
