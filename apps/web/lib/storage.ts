export { createStorageProvider } from "@motion/storage";

import { createStorageProvider } from "@motion/storage";

let _storage: ReturnType<typeof createStorageProvider> | null = null;

export function getStorage() {
  if (!_storage) {
    _storage = createStorageProvider();
  }
  return _storage;
}
