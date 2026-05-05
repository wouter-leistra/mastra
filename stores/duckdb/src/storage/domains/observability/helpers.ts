import { DuckDBConnection } from '../../db/index';
import type { LiveCursor } from '@mastra/core/storage';

/** Shorthand for {@link DuckDBConnection.sqlValue}. */
export const v = DuckDBConnection.sqlValue;

/** Serialize a value to JSON then SQL-escape it, or return 'NULL'. */
export function jsonV(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  return DuckDBConnection.sqlValue(JSON.stringify(val));
}

/** Coerce a value to a Date. Throws if value is nullish. */
export function toDate(val: unknown): Date {
  if (val === null || val === undefined) {
    throw new Error('Expected date value but received null/undefined');
  }
  const date = val instanceof Date ? val : new Date(String(val));
  if (Number.isNaN(date.getTime())) {
    throw new Error('Expected valid date but received invalid date');
  }
  return date;
}

/** Coerce a value to a Date, returning null for nullish values. */
export function toDateOrNull(val: unknown): Date | null {
  if (val === null || val === undefined) return null;
  return val instanceof Date ? val : new Date(String(val));
}

/** Parse a JSON string, returning the original value if parsing fails. */
export function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/** Parse a JSON string and return the result only if it is an array. */
export function parseJsonArray(value: unknown): unknown[] | null {
  if (value === null || value === undefined) return null;
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed : null;
}

export function createIngestedAt(): Date {
  return new Date();
}

export function createSyntheticNowCursor(base = createIngestedAt()): LiveCursor {
  return {
    ingestedAt: base,
    tieBreaker: '!',
  };
}

export function createLiveCursor(ingestedAt: unknown, tieBreaker: string): LiveCursor {
  return {
    ingestedAt: toDate(ingestedAt),
    tieBreaker,
  };
}

export function compareLiveCursors(a: LiveCursor, b: LiveCursor): number {
  const timeDiff = a.ingestedAt.getTime() - b.ingestedAt.getTime();
  if (timeDiff !== 0) return timeDiff;
  return a.tieBreaker.localeCompare(b.tieBreaker);
}

export function isLiveCursorAfter(candidate: LiveCursor, after: LiveCursor): boolean {
  return compareLiveCursors(candidate, after) > 0;
}

export function maxLiveCursor(cursors: Iterable<LiveCursor>): LiveCursor | null {
  let maxCursor: LiveCursor | null = null;
  for (const cursor of cursors) {
    if (maxCursor === null || compareLiveCursors(cursor, maxCursor) > 0) {
      maxCursor = cursor;
    }
  }
  return maxCursor;
}

// TODO(2.0): Replace this local coercion layer with shared observability parsing once runtime core-version compatibility is no longer required.
type PaginationArgs = {
  page?: unknown;
  perPage?: unknown;
};

type ObservabilityListArgsLike<TFilters, TOrderBy> = {
  mode?: 'page' | 'delta';
  filters?: TFilters;
  pagination?: PaginationArgs;
  orderBy?: Partial<TOrderBy> | Record<string, unknown>;
  after?: LiveCursor | { ingestedAt?: unknown; tieBreaker?: unknown };
  limit?: unknown;
};

type NormalizedObservabilityListArgs<TFilters, TOrderBy> = {
  mode: 'page' | 'delta';
  filters: TFilters | undefined;
  pagination: { page: number; perPage: number };
  orderBy: TOrderBy;
  after: LiveCursor | undefined;
  limit: number;
};

export function normalizeObservabilityListArgs<TFilters, TOrderBy extends Record<string, unknown>>(
  args: ObservabilityListArgsLike<TFilters, TOrderBy>,
  defaults: {
    orderBy: TOrderBy;
    pagination?: { page: number; perPage: number };
    limit?: number;
  },
): NormalizedObservabilityListArgs<TFilters, TOrderBy> {
  const paginationDefaults = defaults.pagination ?? { page: 0, perPage: 10 };
  const limitDefault = defaults.limit ?? 10;
  const pagination = args.pagination ?? {};
  const orderBy = args.orderBy ?? {};

  return {
    mode: args.mode === 'delta' ? 'delta' : 'page',
    filters: args.filters,
    pagination: {
      page:
        typeof pagination.page === 'number' && Number.isInteger(pagination.page) && pagination.page >= 0
          ? pagination.page
          : paginationDefaults.page,
      perPage:
        typeof pagination.perPage === 'number' &&
        Number.isInteger(pagination.perPage) &&
        pagination.perPage >= 1 &&
        pagination.perPage <= 100
          ? pagination.perPage
          : paginationDefaults.perPage,
    },
    orderBy: { ...defaults.orderBy, ...orderBy } as TOrderBy,
    after:
      args.after && typeof args.after.tieBreaker === 'string'
        ? createLiveCursor(args.after.ingestedAt, args.after.tieBreaker)
        : undefined,
    limit:
      typeof args.limit === 'number' && Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= 100
        ? args.limit
        : limitDefault,
  };
}
