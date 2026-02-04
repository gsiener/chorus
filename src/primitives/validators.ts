/**
 * Reusable error classes and validation functions
 *
 * These primitives provide type-safe error handling with discriminated unions
 * using the _tag pattern for exhaustive type checking.
 */

// =============================================================================
// Error Classes with _tag discriminator
// =============================================================================

/**
 * Error thrown when a required field is empty or contains only whitespace.
 */
export class EmptyValueError extends Error {
  readonly _tag = "EmptyValueError" as const;
  constructor(public readonly fieldName: string) {
    super(`${fieldName} cannot be empty`);
    this.name = "EmptyValueError";
  }
}

/**
 * Error thrown when a string value exceeds its maximum allowed length.
 */
export class ValueTooLongError extends Error {
  readonly _tag = "ValueTooLongError" as const;
  constructor(
    public readonly fieldName: string,
    public readonly length: number,
    public readonly maxLength: number
  ) {
    super(`${fieldName} too long (${length} chars). Max is ${maxLength} chars.`);
    this.name = "ValueTooLongError";
  }
}

/**
 * Error thrown when content exceeds the maximum allowed size.
 */
export class ContentTooLargeError extends Error {
  readonly _tag = "ContentTooLargeError" as const;
  constructor(
    public readonly size: number,
    public readonly maxSize: number
  ) {
    super(`Content too large (${size} chars). Max size is ${maxSize} chars.`);
    this.name = "ContentTooLargeError";
  }
}

/**
 * Error thrown when a storage system has reached its capacity limit.
 */
export class StorageFullError extends Error {
  readonly _tag = "StorageFullError" as const;
  constructor(
    public readonly storeName: string,
    public readonly currentSize: number,
    public readonly maxSize: number
  ) {
    super(`${storeName} full. Current: ${currentSize} chars, limit: ${maxSize} chars.`);
    this.name = "StorageFullError";
  }
}

/**
 * Error thrown when attempting to create an entity that already exists.
 */
export class DuplicateError extends Error {
  readonly _tag = "DuplicateError" as const;
  constructor(
    public readonly entityType: string,
    public readonly identifier: string
  ) {
    super(`A ${entityType} with identifier "${identifier}" already exists.`);
    this.name = "DuplicateError";
  }
}

/**
 * Error thrown when a requested entity cannot be found.
 */
export class NotFoundError extends Error {
  readonly _tag = "NotFoundError" as const;
  constructor(
    public readonly entityType: string,
    public readonly identifier: string
  ) {
    super(`${entityType} "${identifier}" not found.`);
    this.name = "NotFoundError";
  }
}

/**
 * Error thrown when a key is invalid (e.g., results in empty string after sanitization).
 */
export class InvalidKeyError extends Error {
  readonly _tag = "InvalidKeyError" as const;
  constructor(public readonly key: string) {
    super(`Invalid key: "${key}" results in empty key after sanitization`);
    this.name = "InvalidKeyError";
  }
}

/**
 * Union type of all validation errors for exhaustive type checking.
 */
export type ValidationError =
  | EmptyValueError
  | ValueTooLongError
  | ContentTooLargeError
  | StorageFullError
  | DuplicateError
  | NotFoundError
  | InvalidKeyError;

// =============================================================================
// Validation Result Type
// =============================================================================

/**
 * Discriminated union for type-safe validation results.
 * Use pattern matching on `success` to handle both cases.
 *
 * @example
 * const result = validateNotEmpty(value, "title");
 * if (result.success) {
 *   // result.value is available here
 * } else {
 *   // result.error is available here
 * }
 */
export type ValidationResult<T, E extends Error = Error> =
  | { success: true; value: T }
  | { success: false; error: E };

/**
 * Helper to create a successful validation result.
 */
export function ok<T>(value: T): ValidationResult<T, never> {
  return { success: true, value };
}

/**
 * Helper to create a failed validation result.
 */
export function err<E extends Error>(error: E): ValidationResult<never, E> {
  return { success: false, error };
}

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Validates that a string value is not empty or whitespace-only.
 *
 * @param value - The string to validate
 * @param fieldName - Name of the field (used in error message)
 * @returns ValidationResult with trimmed value on success, EmptyValueError on failure
 */
export function validateNotEmpty(
  value: string,
  fieldName: string
): ValidationResult<string, EmptyValueError> {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return err(new EmptyValueError(fieldName));
  }
  return ok(trimmed);
}

/**
 * Validates that a string value does not exceed a maximum length.
 *
 * @param value - The string to validate
 * @param maxLength - Maximum allowed length
 * @param fieldName - Name of the field (used in error message)
 * @returns ValidationResult with original value on success, ValueTooLongError on failure
 */
export function validateMaxLength(
  value: string,
  maxLength: number,
  fieldName: string
): ValidationResult<string, ValueTooLongError> {
  if (value.length > maxLength) {
    return err(new ValueTooLongError(fieldName, value.length, maxLength));
  }
  return ok(value);
}

/**
 * Validates that content does not exceed a maximum size.
 *
 * @param content - The content to validate
 * @param maxSize - Maximum allowed size in characters
 * @returns ValidationResult with original content on success, ContentTooLargeError on failure
 */
export function validateContentSize(
  content: string,
  maxSize: number
): ValidationResult<string, ContentTooLargeError> {
  if (content.length > maxSize) {
    return err(new ContentTooLargeError(content.length, maxSize));
  }
  return ok(content);
}

/**
 * Validates that adding content won't exceed storage capacity.
 *
 * @param storeName - Name of the storage (used in error message)
 * @param currentSize - Current size of stored content
 * @param additionalSize - Size of content to add
 * @param maxSize - Maximum allowed total size
 * @returns ValidationResult with void on success, StorageFullError on failure
 */
export function validateStorageCapacity(
  storeName: string,
  currentSize: number,
  additionalSize: number,
  maxSize: number
): ValidationResult<void, StorageFullError> {
  if (currentSize + additionalSize > maxSize) {
    return err(new StorageFullError(storeName, currentSize, maxSize));
  }
  return ok(undefined);
}

/**
 * Combines multiple validation results, returning the first error encountered
 * or the final value if all validations pass.
 *
 * @example
 * const result = combineValidations(
 *   () => validateNotEmpty(title, "Title"),
 *   () => validateMaxLength(title, 100, "Title"),
 *   () => validateContentSize(content, 10000)
 * );
 */
export function combineValidations<T>(
  ...validations: Array<() => ValidationResult<unknown, Error>>
): ValidationResult<T, Error> {
  for (const validate of validations) {
    const result = validate();
    if (!result.success) {
      return result as ValidationResult<T, Error>;
    }
  }
  // Return the last successful value (caller must ensure type safety)
  const lastResult = validations[validations.length - 1]?.();
  if (lastResult && lastResult.success) {
    return lastResult as ValidationResult<T, Error>;
  }
  return ok(undefined as T);
}

/**
 * Type guard to check if an error is a specific validation error type.
 *
 * @example
 * if (isValidationError(error, "EmptyValueError")) {
 *   // error is narrowed to EmptyValueError
 * }
 */
export function isValidationError<T extends ValidationError["_tag"]>(
  error: Error,
  tag: T
): error is Extract<ValidationError, { _tag: T }> {
  return "_tag" in error && (error as ValidationError)._tag === tag;
}
