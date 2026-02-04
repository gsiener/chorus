/**
 * Reusable formatting utilities for pagination, dates, and text display.
 */

export interface PaginationInfo {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasMore: boolean;
}

/**
 * Calculate pagination from items array
 */
export function calculatePagination<T>(
  items: T[],
  page: number = 1,
  pageSize: number = 10,
  maxPageSize: number = 50
): { paginatedItems: T[]; pagination: PaginationInfo } {
  const normalizedPage = Math.max(1, page);
  const normalizedPageSize = Math.max(1, Math.min(maxPageSize, pageSize));
  const totalItems = items.length;
  const totalPages = Math.ceil(totalItems / normalizedPageSize);

  const startIndex = (normalizedPage - 1) * normalizedPageSize;
  const paginatedItems = items.slice(startIndex, startIndex + normalizedPageSize);

  return {
    paginatedItems,
    pagination: {
      page: normalizedPage,
      pageSize: normalizedPageSize,
      totalItems,
      totalPages,
      hasMore: normalizedPage < totalPages,
    },
  };
}

/**
 * Format pagination header like "(page 1/3, 25 total)" or "(10 items)"
 */
export function formatPaginationHeader(
  pagination: PaginationInfo,
  itemLabel: string = "items"
): string {
  if (pagination.totalPages > 1) {
    return `(page ${pagination.page}/${pagination.totalPages}, ${pagination.totalItems} ${itemLabel})`;
  }
  return `(${pagination.totalItems} ${itemLabel})`;
}

/**
 * Format "more pages" hint
 */
export function formatMorePagesHint(
  pagination: PaginationInfo,
  command: string
): string | null {
  if (!pagination.hasMore) return null;
  return `_Use \`${command} --page ${pagination.page + 1}\` for more_`;
}

/**
 * Format date for display (localized short date)
 */
export function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString();
}

/**
 * Truncate text with ellipsis
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Extract snippet around a match
 */
export function extractSnippet(
  text: string,
  matchIndex: number,
  matchLength: number,
  contextBefore: number = 30,
  contextAfter: number = 50
): string {
  const start = Math.max(0, matchIndex - contextBefore);
  const end = Math.min(text.length, matchIndex + matchLength + contextAfter);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return prefix + text.slice(start, end) + suffix;
}
