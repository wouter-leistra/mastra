import type { ClickHouseClient } from '@clickhouse/client';
import type { BatchCreateLogsArgs, ListLogsArgs, ListLogsResponse, LiveCursor } from '@mastra/core/storage';

import { TABLE_LOG_EVENTS } from './ddl';
import { buildLogsFilterConditions, buildPaginationClause, buildSignalOrderByClause } from './filters';
import {
  CH_INSERT_SETTINGS,
  CH_SETTINGS,
  createLiveCursor,
  createSyntheticNowCursor,
  normalizeObservabilityListArgs,
  toDateRangeOrUndefined,
  toStringArrayOrUndefined,
  toStringOrUndefined,
  toUnknownRecordOrUndefined,
  logRecordToRow,
  rowToLogRecord,
} from './helpers';

type NormalizedLogsFilters = Parameters<typeof buildLogsFilterConditions>[0];

function normalizeLogsFilters(filters: ListLogsArgs['filters']): NormalizedLogsFilters {
  const record = toUnknownRecordOrUndefined(filters);
  if (!record) return undefined;

  return {
    ...record,
    timestamp: toDateRangeOrUndefined(record.timestamp),
    source: toStringOrUndefined(record.source),
    executionSource: toStringOrUndefined(record.executionSource),
    level: Array.isArray(record.level) ? toStringArrayOrUndefined(record.level) : toStringOrUndefined(record.level),
  } as NormalizedLogsFilters;
}

function rowToLogLiveCursor(row: Record<string, unknown>): LiveCursor | null {
  if (row.ingestedAt == null || row.logId == null) return null;
  return createLiveCursor(row.ingestedAt, String(row.logId));
}

async function getLogsSnapshotLiveCursor(
  client: ClickHouseClient,
  whereClause: string,
  params: Record<string, unknown>,
): Promise<LiveCursor> {
  const rows = (await (
    await client.query({
      query: `
        SELECT ingestedAt, logId
        FROM ${TABLE_LOG_EVENTS} AS l
        ${whereClause ? `${whereClause} AND l.ingestedAt IS NOT NULL` : 'WHERE l.ingestedAt IS NOT NULL'}
        ORDER BY l.ingestedAt DESC, l.logId DESC
        LIMIT 1
      `,
      query_params: params,
      format: 'JSONEachRow',
      clickhouse_settings: CH_SETTINGS,
    })
  ).json()) as Record<string, unknown>[];

  const cursor = rows[0] ? rowToLogLiveCursor(rows[0]) : null;
  return cursor ?? createSyntheticNowCursor();
}

export async function batchCreateLogs(client: ClickHouseClient, args: BatchCreateLogsArgs): Promise<void> {
  if (args.logs.length === 0) return;

  await client.insert({
    table: TABLE_LOG_EVENTS,
    values: args.logs.map(logRecordToRow),
    format: 'JSONEachRow',
    clickhouse_settings: CH_INSERT_SETTINGS,
  });
}

export async function listLogs(client: ClickHouseClient, args: ListLogsArgs): Promise<ListLogsResponse> {
  const parsed = normalizeObservabilityListArgs<ListLogsArgs['filters'], NormalizedLogsFilters, { field: 'timestamp'; direction: 'ASC' | 'DESC' }>(args, {
    orderBy: { field: 'timestamp', direction: 'DESC' } as const,
    normalizeFilters: normalizeLogsFilters,
  });
  const filter = buildLogsFilterConditions(parsed.filters, 'l');
  const whereClause = filter.conditions.length ? `WHERE ${filter.conditions.join(' AND ')}` : '';

  if (parsed.mode === 'delta') {
    if (!parsed.after) {
      return {
        delta: { limit: parsed.limit, hasMore: false },
        liveCursor: await getLogsSnapshotLiveCursor(client, whereClause, filter.params),
        logs: [],
      };
    }

    const rows = (await (
      await client.query({
        query: `
          SELECT *
          FROM ${TABLE_LOG_EVENTS} AS l
          ${
            whereClause
              ? `${whereClause} AND l.ingestedAt IS NOT NULL AND (l.ingestedAt > {afterIngestedAt:DateTime64(3)} OR (l.ingestedAt = {afterIngestedAt:DateTime64(3)} AND l.logId > {afterTieBreaker:String}))`
              : 'WHERE l.ingestedAt IS NOT NULL AND (l.ingestedAt > {afterIngestedAt:DateTime64(3)} OR (l.ingestedAt = {afterIngestedAt:DateTime64(3)} AND l.logId > {afterTieBreaker:String}))'
          }
          ORDER BY l.ingestedAt ASC, l.logId ASC
          LIMIT {limit:UInt32}
        `,
        query_params: {
          ...filter.params,
          afterIngestedAt: parsed.after.ingestedAt.getTime(),
          afterTieBreaker: parsed.after.tieBreaker,
          limit: parsed.limit + 1,
        },
        format: 'JSONEachRow',
        clickhouse_settings: CH_SETTINGS,
      })
    ).json()) as Record<string, any>[];

    const pageRows = rows.slice(0, parsed.limit);
    const liveCursor = (pageRows.length > 0 ? rowToLogLiveCursor(pageRows[pageRows.length - 1]!) : null) ?? parsed.after;

    return {
      delta: { limit: parsed.limit, hasMore: rows.length > parsed.limit },
      liveCursor,
      logs: pageRows.map(rowToLogRecord),
    };
  }

  const pagination = buildPaginationClause(parsed.pagination);
  const orderBy = buildSignalOrderByClause(['timestamp'], parsed.orderBy, 'l');

  const countResult = (await (
    await client.query({
      query: `SELECT count() AS total FROM ${TABLE_LOG_EVENTS} AS l ${whereClause}`,
      query_params: filter.params,
      format: 'JSONEachRow',
      clickhouse_settings: CH_SETTINGS,
    })
  ).json()) as Array<{ total?: number }>;

  const rows = (await (
    await client.query({
      query: `
        SELECT *
        FROM ${TABLE_LOG_EVENTS} AS l
        ${whereClause}
        ORDER BY ${orderBy}
        LIMIT {limit:UInt32} OFFSET {offset:UInt32}
      `,
      query_params: {
        ...filter.params,
        limit: pagination.limit,
        offset: pagination.offset,
      },
      format: 'JSONEachRow',
      clickhouse_settings: CH_SETTINGS,
    })
  ).json()) as Record<string, any>[];

  const total = Number(countResult[0]?.total ?? 0);

  return {
    pagination: {
      total,
      page: pagination.page,
      perPage: pagination.perPage,
      hasMore: (pagination.page + 1) * pagination.perPage < total,
    },
    liveCursor: await getLogsSnapshotLiveCursor(client, whereClause, filter.params),
    logs: rows.map(rowToLogRecord),
  };
}
