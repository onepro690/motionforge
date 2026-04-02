import fs from "fs/promises";
import path from "path";
import type { StorageProvider, UploadOptions, StorageFile } from "./types";

export class LocalStorageProvider implements StorageProvider {
  private basePath: string;
  private baseUrl: string;

  constructor(basePath: string, baseUrl: string) {
    this.basePath = basePath;
    this.baseUrl = baseUrl;
  }

  async upload(options: UploadOptions): Promise<StorageFile> {
    const filePath = path.join(this.basePath, options.key);
    const dir = path.dirname(filePath);

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, options.buffer);

    return {
      key: options.key,
      url: this.getUrl(options.key),
      size: options.buffer.length,
      mimeType: options.mimeType,
    };
  }

  async delete(key: string): Promise<void> {
    const filePath = path.join(this.basePath, key);
    try {
      await fs.unlink(filePath);
    } catch {
      // ignore if not found
    }
  }

  getUrl(key: string): string {
    return `${this.baseUrl}/api/uploads/${key}`;
  }

  async getSignedUrl(key: string, _expiresIn?: number): Promise<string> {
    return this.getUrl(key);
  }
}
