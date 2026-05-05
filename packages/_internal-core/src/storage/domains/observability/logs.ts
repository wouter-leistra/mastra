import { z } from 'zod/v4';
import {
  commonFilterFields,
  contextFields,
  deltaInfoSchema,
  deltaLimitSchema,
  deltaModeSchema,
  liveCursorSchema,
  metadataField,
  paginationArgsSchema,
  paginationInfoSchema,
  pageModeSchema,
  sortDirectionSchema,
  spanIdField,
  tagsField,
  traceIdField,
} from '../shared';

// ============================================================================
// Field Schemas
// ============================================================================

/** Log level schema for validation */
export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error', 'fatal']);

const messageField = z.string().describe('Log message');
const logDataField = z.record(z.string(), z.unknown()).describe('Structured data attached to the log');

// ============================================================================
// LogRecord Schema (Storage Format)
// ============================================================================

/**
 * Schema for logs as stored in the database.
 * Includes all fields from ExportedLog plus storage-specific fields.
 */
export const logRecordSchema = z
  .object({
    logId: z.string().nullish().describe('Unique id for this log event'),
    timestamp: z.date().describe('When the log was created'),
    level: logLevelSchema.describe('Log severity level'),
    message: messageField,
    data: logDataField.nullish(),

    // Correlation
    traceId: traceIdField.nullish(),
    spanId: spanIdField.nullish(),

    // Context fields
    ...contextFields,
    /**
     * @deprecated Use `executionSource` instead.
     */
    source: z.string().nullish().describe('Execution source'),

    metadata: metadataField.nullish(),
  })
  .describe('Log record as stored in the database');

/** Log record type for storage */
export type LogRecord = z.infer<typeof logRecordSchema>;

// ============================================================================
// LogRecordInput Schema (User-Facing API)
// ============================================================================

/**
 * Schema for user-provided log input (minimal required fields).
 * The logger enriches this with context before emitting ExportedLog.
 */
export const logRecordInputSchema = z
  .object({
    level: logLevelSchema,
    message: messageField,
    data: logDataField.optional(),
    tags: tagsField.optional(),
  })
  .describe('User-provided log input');

/** User-facing log input type */
export type LogRecordInput = z.infer<typeof logRecordInputSchema>;

// ============================================================================
// Create Log Schemas
// ============================================================================

/** Schema for creating a log record */
export const createLogRecordSchema = logRecordSchema;

/** Log record for creation (excludes db timestamps) */
export type CreateLogRecord = z.infer<typeof createLogRecordSchema>;

/** Schema for batchCreateLogs operation arguments */
export const batchCreateLogsArgsSchema = z
  .object({
    logs: z.array(createLogRecordSchema),
  })
  .describe('Arguments for batch creating logs');

/** Arguments for batch creating logs */
export type BatchCreateLogsArgs = z.infer<typeof batchCreateLogsArgsSchema>;

// ============================================================================
// Log Filter Schema
// ============================================================================

/** Schema for filtering logs in list queries */
export const logsFilterSchema = z
  .object({
    ...commonFilterFields,

    // Log-specific filters
    /**
     * @deprecated Use `executionSource` instead.
     */
    source: z.string().optional().describe('Filter by execution source'),
    level: z
      .union([logLevelSchema, z.array(logLevelSchema)])
      .optional()
      .describe('Filter by log level(s)'),
  })
  .describe('Filters for querying logs');

/** Filters for querying logs */
export type LogsFilter = z.infer<typeof logsFilterSchema>;

// ============================================================================
// List Logs Schemas
// ============================================================================

/** Fields available for ordering log results */
export const logsOrderByFieldSchema = z.enum(['timestamp']).describe("Field to order by: 'timestamp'");

/** Order by configuration for log queries */
export const logsOrderBySchema = z
  .object({
    field: logsOrderByFieldSchema.default('timestamp').describe('Field to order by'),
    direction: sortDirectionSchema.default('DESC').describe('Sort direction'),
  })
  .describe('Order by configuration');

/** Schema for listLogs operation arguments */
export const listLogsPageArgsSchema = z
  .object({
    mode: pageModeSchema.optional().describe('Default paged list mode'),
    filters: logsFilterSchema.optional().describe('Optional filters to apply'),
    pagination: paginationArgsSchema.default({ page: 0, perPage: 10 }).describe('Pagination settings'),
    orderBy: logsOrderBySchema
      .default({ field: 'timestamp', direction: 'DESC' })
      .describe('Ordering configuration (defaults to timestamp desc)'),
  })
  .strict()
  .describe('Arguments for listing logs in page mode');

/** Schema for listLogs delta polling arguments. */
export const listLogsDeltaArgsSchema = z
  .object({
    mode: deltaModeSchema,
    filters: logsFilterSchema.optional().describe('Optional filters to apply'),
    after: liveCursorSchema.optional().describe('Resume cursor from a prior page or delta response'),
    limit: deltaLimitSchema,
  })
  .strict()
  .describe('Arguments for listing logs in delta mode');

/** Schema for listLogs operation arguments */
export const listLogsArgsSchema = z
  .union([listLogsPageArgsSchema, listLogsDeltaArgsSchema])
  .describe('Arguments for listing logs');

/** Arguments for listing logs */
export type ListLogsArgs = z.input<typeof listLogsArgsSchema>;

/** Schema for paged listLogs responses. */
export const listLogsPageResponseSchema = z.object({
  pagination: paginationInfoSchema,
  liveCursor: liveCursorSchema
    .nullable()
    .optional()
    .describe('Filtered snapshot watermark for subsequent delta polling'),
  logs: z.array(logRecordSchema),
});

/** Schema for delta listLogs responses. */
export const listLogsDeltaResponseSchema = z.object({
  delta: deltaInfoSchema,
  liveCursor: liveCursorSchema.nullable().describe('Resume cursor for the next delta poll'),
  logs: z.array(logRecordSchema),
});

/** Schema for listLogs operation response */
export const listLogsResponseSchema = z
  .union([listLogsPageResponseSchema, listLogsDeltaResponseSchema])
  .describe('Response from listing logs in either page or delta mode');

/** Response containing paginated logs */
export type ListLogsResponse = z.infer<typeof listLogsResponseSchema>;
