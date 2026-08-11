import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as efs from "aws-cdk-lib/aws-efs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { getConfig } from "./config";

interface ApiStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  cluster: ecs.Cluster;
  database: rds.DatabaseInstance;
  databaseSecret: secretsmanager.ISecret;
  appAuthSecret: secretsmanager.ISecret;
  fileSystem: efs.IFileSystem;
  accessPoint: efs.IAccessPoint;
}

export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const config = getConfig();
    const production = config.nodeEnv === "production";
    const publicSubnets = config.publicSubnetIds.map((subnetId, index) =>
      ec2.Subnet.fromSubnetId(this, `PublicSubnet${index}`, subnetId),
    );
    const privateSubnets = config.privateSubnetIds.map((subnetId, index) =>
      ec2.Subnet.fromSubnetId(this, `PrivateSubnet${index}`, subnetId),
    );
    const repo = ecr.Repository.fromRepositoryName(
      this,
      "CicRepository",
      config.ecrRepoName,
    );
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "ExistingCertificate",
      config.certificateArn,
    );
    const serviceSecurityGroup = new ec2.SecurityGroup(
      this,
      "ApiSecurityGroup",
      { vpc: props.vpc, allowAllOutbound: true },
    );

    const service = new ecsPatterns.ApplicationLoadBalancedFargateService(
      this,
      "CicApiService",
      {
        serviceName: config.api.serviceName,
        cluster: props.cluster,
        cpu: config.api.cpu,
        memoryLimitMiB: config.api.memory,
        desiredCount: config.api.desiredCount,
        taskSubnets: { subnets: privateSubnets },
        securityGroups: [serviceSecurityGroup],
        platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
        publicLoadBalancer: true,
        certificate,
        redirectHTTP: true,
        circuitBreaker: { rollback: true },
        healthCheckGracePeriod: cdk.Duration.seconds(60),
        taskImageOptions: {
          image: ecs.ContainerImage.fromEcrRepository(repo, "latest"),
          containerPort: config.api.containerPort,
          command: [
            "sh",
            "-c",
            "node scripts/seed-admin.js && exec node index.js",
          ],
          environment: {
            NODE_ENV: config.nodeEnv,
            SERVICE_ROLE: "api",
            PORT: String(config.api.containerPort),
            DATABASE_SSL: "false",
            PGHOST: props.database.dbInstanceEndpointAddress,
            PGPORT: props.database.dbInstanceEndpointPort,
            PGDATABASE: config.database.name,
            COOKIE_SECURE: "true",
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
            ADMIN_USERNAME: ecs.Secret.fromSecretsManager(
              props.appAuthSecret,
              "username",
            ),
            ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(
              props.appAuthSecret,
              "password",
            ),
          },
          logDriver: ecs.LogDrivers.awsLogs({
            streamPrefix: production ? "cic-api-production" : "cic-api",
          }),
        },
      },
    );

    service.taskDefinition.addVolume({
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
    service.taskDefinition.defaultContainer?.addMountPoints({
      sourceVolume: "catalogs",
      containerPath: "/app/catalogs",
      readOnly: false,
    });
    props.fileSystem.grantRootAccess(service.taskDefinition.taskRole);
    props.databaseSecret.grantRead(service.taskDefinition.taskRole);
    props.appAuthSecret.grantRead(service.taskDefinition.taskRole);

    service.targetGroup.configureHealthCheck({
      path: config.api.healthCheckPath,
      port: String(config.api.containerPort),
      healthyHttpCodes: "200",
      interval: cdk.Duration.seconds(config.api.healthCheckInterval),
      timeout: cdk.Duration.seconds(config.api.healthCheckTimeout),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 5,
    });
    service.loadBalancer.setAttribute("idle_timeout.timeout_seconds", "3600");
    const albResource = service.loadBalancer.node.defaultChild as cdk.CfnResource;
    albResource.addOverride(
      "Properties.Subnets",
      publicSubnets.map((subnet) => subnet.subnetId),
    );

    const exportName = production
      ? "CicApiAlbDnsProduction"
      : "CicApiAlbDns";
    new cdk.CfnOutput(this, "ApiAlbDns", {
      value: service.loadBalancer.loadBalancerDnsName,
      description: "CIC API load balancer DNS name",
      exportName,
    });
    new cdk.CfnOutput(this, "RepositoryUri", {
      value: repo.repositoryUri,
    });
  }
}
