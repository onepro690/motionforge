import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageProvider, UploadOptions, StorageFile } from "./types";

interface S3Config {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
  endpoint?: string;
  publicUrl?: string;
}

export class S3StorageProvider implements StorageProvider {
  private client: S3Client;
  private bucket: string;
  private publicUrl?: string;
  private region: string;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.publicUrl = config.publicUrl;
    this.region = config.region;

    this.client = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    });
  }

  async upload(options: UploadOptions): Promise<StorageFile> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: options.key,
        Body: options.buffer,
        ContentType: options.mimeType,
        Metadata: options.metadata,
      })
    );

    return {
      key: options.key,
      url: this.getUrl(options.key),
      size: options.buffer.length,
      mimeType: options.mimeType,
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
    );
  }

  getUrl(key: string): string {
    if (this.publicUrl) return `${this.publicUrl}/${key}`;
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }

  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn });
  }
}
