import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as efs from "aws-cdk-lib/aws-efs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { getConfig } from "./config";

interface WorkerStackProps extends cdk.StackProps {
  cluster: ecs.Cluster;
  vpc: ec2.IVpc;
  database: rds.DatabaseInstance;
  databaseSecret: secretsmanager.ISecret;
  appAuthSecret: secretsmanager.ISecret;
  fileSystem: efs.IFileSystem;
  accessPoint: efs.IAccessPoint;
}

export class WorkerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WorkerStackProps) {
    super(scope, id, props);
    const config = getConfig();
    const production = config.nodeEnv === "production";
    const privateSubnets = config.privateSubnetIds.map((subnetId, index) =>
      ec2.Subnet.fromSubnetId(this, `PrivateSubnet${index}`, subnetId),
    );
    const repo = ecr.Repository.fromRepositoryName(
      this,
      "CicRepository",
      config.ecrRepoName,
    );
    const serviceSecurityGroup = new ec2.SecurityGroup(
      this,
      "SchedulerSecurityGroup",
      { vpc: props.vpc, allowAllOutbound: true },
    );
    const task = new ecs.FargateTaskDefinition(this, "SchedulerTask", {
      cpu: config.worker.cpu,
      memoryLimitMiB: config.worker.memory,
    });

    task.addVolume({
      name: "catalogs",
      efsVolumeConfiguration: {
        fileSystemId: props.fileSystem.fileSystemId,
        transitEncryption: "ENABLED",
        authorizationConfig: {
          accessPointId: props.accessPoint.accessPointId,
          iam: "ENABLED",
        },
      },
    });
    const container = task.addContainer("SchedulerContainer", {
      image: ecs.ContainerImage.fromEcrRepository(repo, "latest"),
      command: ["node", "index.js"],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: production
          ? "cic-scheduler-production"
          : "cic-scheduler",
      }),
      environment: {
        NODE_ENV: config.nodeEnv,
        SERVICE_ROLE: "scheduler",
        DATABASE_SSL: "false",
        PGHOST: props.database.dbInstanceEndpointAddress,
        PGPORT: props.database.dbInstanceEndpointPort,
        PGDATABASE: config.database.name,
        DAILY_REFRESH_ENABLED: String(config.scheduler.enabled),
        DAILY_REFRESH_HOUR_IST: String(config.scheduler.hourIst),
        DAILY_REFRESH_MINUTE_IST: String(config.scheduler.minuteIst),
        DAILY_REFRESH_LANG: config.scheduler.lang,
        DAILY_REFRESH_SPACING_MINUTES: String(
          config.scheduler.spacingMinutes,
        ),
      },
      secrets: {
        PGUSER: ecs.Secret.fromSecretsManager(
          props.databaseSecret,
          "username",
        ),
        PGPASSWORD: ecs.Secret.fromSecretsManager(
          props.databaseSecret,
          "password",
        ),
      },
    });
    container.addMountPoints({
      sourceVolume: "catalogs",
      containerPath: "/app/catalogs",
      readOnly: false,
    });

    props.fileSystem.grantRootAccess(task.taskRole);
    props.databaseSecret.grantRead(task.taskRole);

    new ecs.FargateService(this, "SchedulerService", {
      serviceName: config.worker.serviceName,
      cluster: props.cluster,
      taskDefinition: task,
      desiredCount: config.worker.desiredCount,
      securityGroups: [serviceSecurityGroup],
      vpcSubnets: { subnets: privateSubnets },
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
      circuitBreaker: { rollback: true },
    });
  }
}
