export interface StorageFile {
  key: string;
  url: string;
  size: number;
  mimeType: string;
}

export interface UploadOptions {
  key: string;
  buffer: Buffer;
  mimeType: string;
  metadata?: Record<string, string>;
}

export interface StorageProvider {
  upload(options: UploadOptions): Promise<StorageFile>;
  delete(key: string): Promise<void>;
  getUrl(key: string): string;
  getSignedUrl(key: string, expiresIn?: number): Promise<string>;
}
