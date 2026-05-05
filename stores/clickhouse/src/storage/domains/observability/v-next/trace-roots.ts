/**
 * Trace-roots operations for ClickHouse v-next observability.
 *
 * Owns: listTraces, getRootSpan
 * Reads from: trace_roots (populated by incremental MV from span_events)
 */

import type { ClickHouseClient } from '@clickhouse/client';
import { toTraceSpans } from '@mastra/core/storage';
import type { GetRootSpanArgs, GetRootSpanResponse, ListTracesArgs, ListTracesResponse, LiveCursor } from '@mastra/core/storage';

import { TABLE_SPAN_EVENTS, TABLE_TRACE_ROOTS } from './ddl';
import { buildTraceFilterConditions, buildTraceOrderByClause } from './filters';
import {
  CH_SETTINGS,
  createLiveCursor,
  createSyntheticNowCursor,
  normalizeObservabilityListArgs,
  rowToSpanRecord,
  toBooleanOrUndefined,
  toDateRangeOrUndefined,
  toStringOrUndefined,
  toStringRecordOrUndefined,
  toUnknownRecordOrUndefined,
} from './helpers';

type NormalizedTraceFilters = Parameters<typeof buildTraceFilterConditions>[0];
type TracesOrderBy = { field: 'startedAt' | 'endedAt'; direction: 'ASC' | 'DESC' };
type NormalizedTraceStatus = Exclude<NormalizedTraceFilters, undefined>['status'];

function normalizeTraceFilters(filters: ListTracesArgs['filters']): NormalizedTraceFilters {
  const record = toUnknownRecordOrUndefined(filters);
  if (!record) return undefined;

  return {
    ...record,
    startedAt: toDateRangeOrUndefined(record.startedAt),
    endedAt: toDateRangeOrUndefined(record.endedAt),
    spanType: toStringOrUndefined(record.spanType),
    entityType: toStringOrUndefined(record.entityType),
    entityId: toStringOrUndefined(record.entityId),
    entityName: toStringOrUndefined(record.entityName),
    entityVersionId: toStringOrUndefined(record.entityVersionId),
    parentEntityVersionId: toStringOrUndefined(record.parentEntityVersionId),
    parentEntityType: toStringOrUndefined(record.parentEntityType),
    parentEntityId: toStringOrUndefined(record.parentEntityId),
    parentEntityName: toStringOrUndefined(record.parentEntityName),
    rootEntityVersionId: toStringOrUndefined(record.rootEntityVersionId),
    rootEntityType: toStringOrUndefined(record.rootEntityType),
    rootEntityId: toStringOrUndefined(record.rootEntityId),
    rootEntityName: toStringOrUndefined(record.rootEntityName),
    experimentId: toStringOrUndefined(record.experimentId),
    userId: toStringOrUndefined(record.userId),
    organizationId: toStringOrUndefined(record.organizationId),
    resourceId: toStringOrUndefined(record.resourceId),
    runId: toStringOrUndefined(record.runId),
    sessionId: toStringOrUndefined(record.sessionId),
    threadId: toStringOrUndefined(record.threadId),
    requestId: toStringOrUndefined(record.requestId),
    environment: toStringOrUndefined(record.environment),
    source: toStringOrUndefined(record.source),
    serviceName: toStringOrUndefined(record.serviceName),
    metadata: toStringRecordOrUndefined(record.metadata),
    hasChildError: toBooleanOrUndefined(record.hasChildError),
    status: record.status as NormalizedTraceStatus,
  } as NormalizedTraceFilters;
}

function rowToTraceLiveCursor(row: Record<string, unknown>): LiveCursor | null {
  if (row.ingestedAt == null || row.tieBreaker == null) return null;
  return createLiveCursor(row.ingestedAt, String(row.tieBreaker));
}

// ---------------------------------------------------------------------------
// getRootSpan
// ---------------------------------------------------------------------------

/**
 * Get the root span for a trace, reading from trace_roots as compatibility path.
 * Uses ordinary LIMIT 1 (duplicates are byte-identical per design).
 */
export async function getRootSpan(
  client: ClickHouseClient,
  args: GetRootSpanArgs,
): Promise<GetRootSpanResponse | null> {
  const result = await client.query({
    query: `
      SELECT *
      FROM ${TABLE_TRACE_ROOTS}
      WHERE traceId = {traceId:String}
      LIMIT 1
    `,
    query_params: { traceId: args.traceId },
    format: 'JSONEachRow',
    clickhouse_settings: CH_SETTINGS,
  });

  const rows = (await result.json()) as Record<string, any>[];
  if (!rows || rows.length === 0) return null;

  return { span: rowToSpanRecord(rows[0]!) };
}

// ---------------------------------------------------------------------------
// listTraces
// ---------------------------------------------------------------------------

/**
 * List traces with optional filtering, pagination, and ordering.
 *
 * Reads from trace_roots (root spans only).
 * Uses two-stage query for ReplacingMergeTree deduplication:
 *   Inner: filter + deterministic ORDER BY + LIMIT 1 BY dedupeKey
 *   Outer: final ordering + pagination
 *
 * hasChildError is handled via EXISTS subquery against span_events.
 */
export async function listTraces(client: ClickHouseClient, args: ListTracesArgs): Promise<ListTracesResponse> {
  const parsed = normalizeObservabilityListArgs<ListTracesArgs['filters'], NormalizedTraceFilters, TracesOrderBy>(args, {
    orderBy: { field: 'startedAt', direction: 'DESC' } satisfies TracesOrderBy,
    normalizeFilters: normalizeTraceFilters,
  });
  const { filters } = parsed;

  // Build filter conditions
  const { conditions, params } = buildTraceFilterConditions(filters, 'r');

  // hasChildError: EXISTS subquery against span_events
  if (filters?.hasChildError != null) {
    if (filters.hasChildError) {
      conditions.push(`EXISTS (
        SELECT 1 FROM ${TABLE_SPAN_EVENTS} c
        WHERE c.traceId = r.traceId
          AND c.parentSpanId IS NOT NULL
          AND c.error IS NOT NULL
      )`);
    } else {
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM ${TABLE_SPAN_EVENTS} c
        WHERE c.traceId = r.traceId
          AND c.parentSpanId IS NOT NULL
          AND c.error IS NOT NULL
      )`);
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const dedupedRootsSql = `
    SELECT *
    FROM ${TABLE_TRACE_ROOTS} r
    ${whereClause}
    ORDER BY dedupeKey
    LIMIT 1 BY dedupeKey
  `;
  const traceActivitySql = `
    SELECT
      traceId,
      max(ingestedAt) AS latestIngestedAt,
      argMax(dedupeKey, tuple(ingestedAt, dedupeKey)) AS latestTieBreaker
    FROM ${TABLE_SPAN_EVENTS}
    WHERE ingestedAt IS NOT NULL
    GROUP BY traceId
  `;

  if (parsed.mode === 'delta') {
    const liveCursorResult = await client.query({
      query: `
        SELECT activity.latestIngestedAt AS ingestedAt, activity.latestTieBreaker AS tieBreaker
        FROM (${dedupedRootsSql}) AS roots
        INNER JOIN (${traceActivitySql}) AS activity USING (traceId)
        ORDER BY activity.latestIngestedAt DESC, activity.latestTieBreaker DESC
        LIMIT 1
      `,
      query_params: params,
      format: 'JSONEachRow',
      clickhouse_settings: CH_SETTINGS,
    });
    const liveCursorRows = (await liveCursorResult.json()) as Record<string, unknown>[];
    const snapshotCursor = (liveCursorRows[0] ? rowToTraceLiveCursor(liveCursorRows[0]) : null) ?? createSyntheticNowCursor();

    if (!parsed.after) {
      return {
        delta: { limit: parsed.limit, hasMore: false },
        liveCursor: snapshotCursor,
        spans: [],
      };
    }

    const deltaResult = await client.query({
      query: `
        SELECT roots.*, activity.latestIngestedAt AS ingestedAt, activity.latestTieBreaker AS tieBreaker
        FROM (${dedupedRootsSql}) AS roots
        INNER JOIN (${traceActivitySql}) AS activity USING (traceId)
        WHERE activity.latestIngestedAt > {afterIngestedAt:DateTime64(3)}
          OR (
            activity.latestIngestedAt = {afterIngestedAt:DateTime64(3)}
            AND activity.latestTieBreaker > {afterTieBreaker:String}
          )
        ORDER BY activity.latestIngestedAt ASC, activity.latestTieBreaker ASC
        LIMIT {limit:UInt32}
      `,
      query_params: {
        ...params,
        afterIngestedAt: parsed.after.ingestedAt.getTime(),
        afterTieBreaker: parsed.after.tieBreaker,
        limit: parsed.limit + 1,
      },
      format: 'JSONEachRow',
      clickhouse_settings: CH_SETTINGS,
    });

    const deltaRows = (await deltaResult.json()) as Record<string, any>[];
    const pageRows = deltaRows.slice(0, parsed.limit);
    const liveCursor =
      (pageRows.length > 0 ? rowToTraceLiveCursor(pageRows[pageRows.length - 1]!) : null) ?? parsed.after;

    return {
      delta: { limit: parsed.limit, hasMore: deltaRows.length > parsed.limit },
      liveCursor,
      spans: toTraceSpans(pageRows.map(rowToSpanRecord)),
    };
  }

  const pagination = parsed.pagination;
  const orderBy = parsed.orderBy;
  const page = pagination?.page ?? 0;
  const perPage = pagination?.perPage ?? 10;
  // Outer ORDER BY must not use table alias — the outer SELECT wraps an anonymous subquery
  const orderClause = buildTraceOrderByClause(orderBy);

  // Count query (deduplicated)
  const countResult = await client.query({
    query: `
      SELECT count() as cnt FROM (
        SELECT dedupeKey
        FROM (${dedupedRootsSql})
      )
    `,
    query_params: params,
    format: 'JSONEachRow',
    clickhouse_settings: CH_SETTINGS,
  });

  const countRows = (await countResult.json()) as Array<{ cnt: string | number }>;
  const total = Number(countRows[0]?.cnt ?? 0);

  if (total === 0) {
    return {
      pagination: { total: 0, page, perPage, hasMore: false },
      liveCursor: createSyntheticNowCursor(),
      spans: [],
    };
  }

  // Data query: two-stage dedupe + pagination
  const dataResult = await client.query({
    query: `
      SELECT * FROM (
        ${dedupedRootsSql}
      )
      ORDER BY ${orderClause}
      LIMIT {limit:UInt32}
      OFFSET {offset:UInt32}
    `,
    query_params: {
      ...params,
      limit: perPage,
      offset: page * perPage,
    },
    format: 'JSONEachRow',
    clickhouse_settings: CH_SETTINGS,
  });

  const rows = (await dataResult.json()) as Record<string, any>[];
  const spans = rows.map(rowToSpanRecord);

  const liveCursorResult = await client.query({
    query: `
      SELECT activity.latestIngestedAt AS ingestedAt, activity.latestTieBreaker AS tieBreaker
      FROM (${dedupedRootsSql}) AS roots
      INNER JOIN (${traceActivitySql}) AS activity USING (traceId)
      ORDER BY activity.latestIngestedAt DESC, activity.latestTieBreaker DESC
      LIMIT 1
    `,
    query_params: params,
    format: 'JSONEachRow',
    clickhouse_settings: CH_SETTINGS,
  });
  const liveCursorRows = (await liveCursorResult.json()) as Record<string, unknown>[];

  return {
    pagination: {
      total,
      page,
      perPage,
      hasMore: (page + 1) * perPage < total,
    },
    liveCursor: (liveCursorRows[0] ? rowToTraceLiveCursor(liveCursorRows[0]) : null) ?? createSyntheticNowCursor(),
    spans: toTraceSpans(spans),
  };
}
