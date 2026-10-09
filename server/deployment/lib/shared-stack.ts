import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as efs from "aws-cdk-lib/aws-efs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { getConfig } from "./config";

export class SharedStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly cluster: ecs.Cluster;
  public readonly database: rds.DatabaseInstance;
  public readonly databaseSecret: secretsmanager.ISecret;
  public readonly appAuthSecret: secretsmanager.ISecret;
  public readonly catalogBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);
    const config = getConfig();
    const production = config.nodeEnv === "production";
    const retainLegacyEfs =
      String(this.node.tryGetContext("retainLegacyEfs") ?? "true") !== "false";

    this.vpc = ec2.Vpc.fromLookup(this, "ExistingVpc", {
      vpcId: config.vpcId,
    });
    const privateSubnets = config.privateSubnetIds.map((subnetId, index) =>
      ec2.Subnet.fromSubnetId(this, `PrivateSubnet${index}`, subnetId),
    );

    this.cluster = new ecs.Cluster(this, "CicCluster", { vpc: this.vpc });
    this.cluster.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    const databaseSecurityGroup = new ec2.SecurityGroup(
      this,
      "DatabaseSecurityGroup",
      { vpc: this.vpc, allowAllOutbound: true },
    );
    databaseSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(5432),
      "PostgreSQL from CIC services",
    );

    this.database = new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      credentials: rds.Credentials.fromGeneratedSecret("cic_admin"),
      databaseName: config.database.name,
      instanceType: new ec2.InstanceType(config.database.instanceType),
      allocatedStorage: config.database.allocatedStorage,
      maxAllocatedStorage: config.database.maxAllocatedStorage,
      storageEncrypted: true,
      multiAz: production,
      publiclyAccessible: false,
      vpc: this.vpc,
      vpcSubnets: { subnets: privateSubnets },
      securityGroups: [databaseSecurityGroup],
      backupRetention: cdk.Duration.days(config.database.backupRetentionDays),
      deletionProtection: production,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    if (!this.database.secret) {
      throw new Error("RDS did not create a credentials secret.");
    }
    this.databaseSecret = this.database.secret;

    this.appAuthSecret = new secretsmanager.Secret(this, "AppAuthSecret", {
      description: "CIC bootstrap administrator credentials",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "cic_admin" }),
        generateStringKey: "password",
        excludePunctuation: true,
        passwordLength: 32,
      },
    });
    this.appAuthSecret.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    this.catalogBucket = new s3.Bucket(this, "CatalogStorage", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: production,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: production
        ? [
            {
              noncurrentVersionExpiration: cdk.Duration.days(30),
              abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
            },
          ]
        : [
            {
              abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
            },
          ],
    });

    // Keep the original constructs and exports for the first S3 rollout. The
    // currently deployed API/worker templates still import these values until
    // their S3 task definitions have deployed. A second shared-stack deploy
    // with -c retainLegacyEfs=false safely removes the now-unused EFS resources.
    if (retainLegacyEfs) {
      const efsSecurityGroup = new ec2.SecurityGroup(
        this,
        "EfsSecurityGroup",
        { vpc: this.vpc, allowAllOutbound: true },
      );
      efsSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
        ec2.Port.tcp(2049),
        "NFS from CIC services",
      );
      const legacyFileSystem = new efs.FileSystem(this, "GeneratedFiles", {
        vpc: this.vpc,
        vpcSubnets: { subnets: privateSubnets },
        securityGroup: efsSecurityGroup,
        encrypted: true,
        lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      const legacyAccessPoint = legacyFileSystem.addAccessPoint(
        "CatalogsAccessPoint",
        {
          path: "/catalogs",
          createAcl: { ownerUid: "100", ownerGid: "101", permissions: "0770" },
          posixUser: { uid: "100", gid: "101" },
        },
      );

      this.exportValue(legacyFileSystem.fileSystemArn);
      this.exportValue(legacyFileSystem.fileSystemId);
      this.exportValue(legacyAccessPoint.accessPointId);

      new cdk.CfnOutput(this, "FileSystemId", {
        value: legacyFileSystem.fileSystemId,
        description: "Legacy EFS retained temporarily for the S3 cutover",
      });
    }

    new cdk.CfnOutput(this, "DatabaseSecretArn", {
      value: this.databaseSecret.secretArn,
    });
    new cdk.CfnOutput(this, "AppAuthSecretArn", {
      value: this.appAuthSecret.secretArn,
    });
    new cdk.CfnOutput(this, "CatalogBucketName", {
      value: this.catalogBucket.bucketName,
    });
    new cdk.CfnOutput(this, "ClusterName", {
      value: this.cluster.clusterName,
    });
  }
}
