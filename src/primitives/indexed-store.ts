/**
 * Generic indexed KV store pattern
 *
 * Both docs.ts and initiatives.ts follow this pattern:
 * 1. Store an index in KV (list of metadata)
 * 2. Store full items separately with a prefix
 * 3. Operations: getIndex, saveIndex, add item, update item, remove item
 *
 * This abstraction provides the common operations while remaining flexible
 * enough to handle different identifier strategies (title-based vs id-based).
 */

import type { Env } from "../types";

/**
 * Configuration for an indexed store
 */
export interface IndexedStoreConfig<TIndex, TItem, TMeta> {
  /** KV key for the index */
  indexKey: string;

  /** Prefix for item keys (e.g., "docs:content:" or "initiatives:detail:") */
  itemPrefix: string;

  /** Function to generate storage key from item ID */
  itemIdToKey: (id: string) => string;

  /** Function to extract ID from a full item */
  getItemId: (item: TItem) => string;

  /** Function to extract ID from metadata */
  getMetaId: (meta: TMeta) => string;

  /** Function to convert full item to metadata for index */
  toMetadata: (item: TItem) => TMeta;

  /** Factory function for empty index */
  emptyIndex: () => TIndex;

  /** Get items array from index */
  getItems: (index: TIndex) => TMeta[];

  /** Set items array in index (returns new index) */
  setItems: (index: TIndex, items: TMeta[]) => TIndex;
}

/**
 * Result type for operations that can fail
 */
export interface StoreResult<T = void> {
  success: boolean;
  message: string;
  data?: T;
}

/**
 * Indexed store instance with common operations
 */
export interface IndexedStore<TIndex, TItem, TMeta> {
  /** Get the full index */
  getIndex(env: Env): Promise<TIndex>;

  /** Save the full index */
  saveIndex(env: Env, index: TIndex): Promise<void>;

  /** Get a single item by ID */
  getItem(env: Env, id: string): Promise<TItem | null>;

  /** Save a single item */
  saveItem(env: Env, item: TItem): Promise<void>;

  /** Delete a single item from KV (does not update index) */
  deleteItem(env: Env, id: string): Promise<void>;

  /** Find metadata in index by predicate */
  findInIndex(env: Env, predicate: (meta: TMeta) => boolean): Promise<TMeta | undefined>;

  /** Check if an item exists in the index */
  existsInIndex(env: Env, predicate: (meta: TMeta) => boolean): Promise<boolean>;

  /** Add or update metadata entry in the index */
  upsertIndexEntry(env: Env, item: TItem): Promise<void>;

  /** Remove an entry from the index by ID */
  removeFromIndex(env: Env, id: string): Promise<boolean>;

  /** Get count of items in index */
  getCount(env: Env): Promise<number>;

  /** Get all items (loads full data for each) */
  getAllItems(env: Env): Promise<TItem[]>;
}

/**
 * Create an indexed store with common operations
 *
 * @example
 * ```typescript
 * const docsStore = createIndexedStore<DocsIndex, Document, DocMetadata>({
 *   indexKey: "docs:index",
 *   itemPrefix: "docs:content:",
 *   itemIdToKey: (id) => `docs:content:${id}`,
 *   getItemId: (doc) => sanitizeTitle(doc.title),
 *   getMetaId: (meta) => sanitizeTitle(meta.title),
 *   toMetadata: (doc) => ({ title: doc.title, addedBy: doc.addedBy, ... }),
 *   emptyIndex: () => ({ documents: [] }),
 *   getItems: (index) => index.documents,
 *   setItems: (index, items) => ({ ...index, documents: items }),
 * });
 * ```
 */
export function createIndexedStore<TIndex, TItem, TMeta>(
  config: IndexedStoreConfig<TIndex, TItem, TMeta>
): IndexedStore<TIndex, TItem, TMeta> {
  async function getIndex(env: Env): Promise<TIndex> {
    const data = await env.DOCS_KV.get(config.indexKey);
    if (!data) return config.emptyIndex();
    return JSON.parse(data) as TIndex;
  }

  async function saveIndex(env: Env, index: TIndex): Promise<void> {
    await env.DOCS_KV.put(config.indexKey, JSON.stringify(index));
  }

  async function getItem(env: Env, id: string): Promise<TItem | null> {
    const key = config.itemIdToKey(id);
    const data = await env.DOCS_KV.get(key);
    if (!data) return null;
    return JSON.parse(data) as TItem;
  }

  async function saveItem(env: Env, item: TItem): Promise<void> {
    const id = config.getItemId(item);
    const key = config.itemIdToKey(id);
    await env.DOCS_KV.put(key, JSON.stringify(item));
  }

  async function deleteItem(env: Env, id: string): Promise<void> {
    const key = config.itemIdToKey(id);
    await env.DOCS_KV.delete(key);
  }

  async function findInIndex(
    env: Env,
    predicate: (meta: TMeta) => boolean
  ): Promise<TMeta | undefined> {
    const index = await getIndex(env);
    return config.getItems(index).find(predicate);
  }

  async function existsInIndex(
    env: Env,
    predicate: (meta: TMeta) => boolean
  ): Promise<boolean> {
    const meta = await findInIndex(env, predicate);
    return meta !== undefined;
  }

  async function upsertIndexEntry(env: Env, item: TItem): Promise<void> {
    const index = await getIndex(env);
    const items = config.getItems(index);
    const id = config.getItemId(item);
    const existingIndex = items.findIndex(
      (m) => config.getMetaId(m) === id
    );

    const newMeta = config.toMetadata(item);

    if (existingIndex >= 0) {
      // Update existing entry
      items[existingIndex] = newMeta;
    } else {
      // Add new entry
      items.push(newMeta);
    }

    const newIndex = config.setItems(index, items);
    await saveIndex(env, newIndex);
  }

  async function removeFromIndex(env: Env, id: string): Promise<boolean> {
    const index = await getIndex(env);
    const items = config.getItems(index);
    const existingIndex = items.findIndex(
      (m) => config.getMetaId(m) === id
    );

    if (existingIndex === -1) {
      return false;
    }

    items.splice(existingIndex, 1);
    const newIndex = config.setItems(index, items);
    await saveIndex(env, newIndex);
    return true;
  }

  async function getCount(env: Env): Promise<number> {
    const index = await getIndex(env);
    return config.getItems(index).length;
  }

  async function getAllItems(env: Env): Promise<TItem[]> {
    const index = await getIndex(env);
    const items = config.getItems(index);

    const itemPromises = items.map(async (meta) => {
      const id = config.getMetaId(meta);
      return getItem(env, id);
    });

    const results = await Promise.all(itemPromises);
    // Filter out nulls - TypeScript needs explicit cast due to generic constraints
    const filtered: TItem[] = [];
    for (const item of results) {
      if (item !== null) {
        filtered.push(item);
      }
    }
    return filtered;
  }

  return {
    getIndex,
    saveIndex,
    getItem,
    saveItem,
    deleteItem,
    findInIndex,
    existsInIndex,
    upsertIndexEntry,
    removeFromIndex,
    getCount,
    getAllItems,
  };
}

/**
 * Helper to create a simple item ID to key function
 */
export function createPrefixedKeyFn(prefix: string): (id: string) => string {
  return (id: string) => prefix + id;
}
