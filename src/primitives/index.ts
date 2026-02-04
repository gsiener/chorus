/**
 * Primitives module - reusable building blocks for the application
 *
 * This module exports common error classes, validation functions, and
 * type-safe result types that can be used across the codebase.
 */

export {
  // Error classes
  EmptyValueError,
  ValueTooLongError,
  ContentTooLargeError,
  StorageFullError,
  DuplicateError,
  NotFoundError,
  InvalidKeyError,
  // Union type for exhaustive checking
  type ValidationError,
  // Result type
  type ValidationResult,
  // Result helpers
  ok,
  err,
  // Validation functions
  validateNotEmpty,
  validateMaxLength,
  validateContentSize,
  validateStorageCapacity,
  combineValidations,
  // Type guards
  isValidationError,
} from "./validators";

export {
  createIndexedStore,
  createPrefixedKeyFn,
  type IndexedStoreConfig,
  type IndexedStore,
  type StoreResult,
} from "./indexed-store";

export {
  calculatePagination,
  formatPaginationHeader,
  formatMorePagesHint,
  formatDate,
  truncate,
  extractSnippet,
  type PaginationInfo,
} from "./formatters";
