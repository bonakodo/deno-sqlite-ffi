/** Invalid native library configuration or permission. */
export class NativeConfigError extends Error {
  /** Error class name. */
  override name = 'NativeConfigError';
}
/** A library could not be loaded or initialized. */
export class NativeLoadError extends Error {
  /** Error class name. */
  override name = 'NativeLoadError';
}
/** The selected library lacks the required core ABI or version. */
export class NativeCompatibilityError extends Error {
  /** Error class name. */
  override name = 'NativeCompatibilityError';
}
/** A requested feature is unavailable in the selected library. */
export class NativeCapabilityError extends Error {
  /** Error class name. */
  override name = 'NativeCapabilityError';
  /** Name of the missing feature. */
  readonly capability: string;
  /** Create a capability error. */
  constructor(capability: string) {
    super(`SQLite capability unavailable: ${capability}`);
    this.capability = capability;
  }
}
