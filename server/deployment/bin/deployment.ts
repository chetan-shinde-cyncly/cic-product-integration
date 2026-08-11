#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ApiStack } from "../lib/api-stack";
import { loadConfig } from "../lib/config";
import { SharedStack } from "../lib/shared-stack";
import { WorkerStack } from "../lib/worker-stack";

const app = new cdk.App();
const envName = app.node.tryGetContext("env") || "dev";
const config = loadConfig(envName);
const env = { account: config.account, region: config.region };

console.log(`Deploying CIC infrastructure to ${envName}.`);

const shared = new SharedStack(app, `${config.stackPrefix}SharedStack`, {
  env,
});

new ApiStack(app, `${config.stackPrefix}ApiStack`, {
  env,
  vpc: shared.vpc,
  cluster: shared.cluster,
  database: shared.database,
  databaseSecret: shared.databaseSecret,
  appAuthSecret: shared.appAuthSecret,
  fileSystem: shared.fileSystem,
  accessPoint: shared.accessPoint,
});

new WorkerStack(app, `${config.stackPrefix}WorkerStack`, {
  env,
  cluster: shared.cluster,
  vpc: shared.vpc,
  database: shared.database,
  databaseSecret: shared.databaseSecret,
  appAuthSecret: shared.appAuthSecret,
  fileSystem: shared.fileSystem,
  accessPoint: shared.accessPoint,
});
