import "server-only";

import { queryDatabase } from "@/lib/db";
import type {
  AdminReviewFilter,
  DeviceProfile,
} from "@/types/admin";
import type { ConversationHistoryEntry } from "@/types/conversation";

type DeviceCounts = {
  clientId: string;
  conversationCount: number;
  unreviewedCount: number;
  approvedCount: number;
  rejectedCount: number;
  lastSeenAt?: string;
};

export type PostgresAdminOverviewSnapshot = {
  conversations: ConversationHistoryEntry[];
  profiles: DeviceProfile[];
  deviceCounts: DeviceCounts[];
  stats: {
    total: number;
    unreviewed: number;
    approved: number;
    rejected: number;
    needsReview: number;
    aiSuggested: number;
    learned: number;
  };
  latencySampleCount: number;
  p95FirstAudioMs: number;
  deletedByRetention: number;
};

type SnapshotRow = {
  conversations: unknown;
  profiles: unknown;
  device_counts: unknown;
  stats: unknown;
  latency_sample_count: string | number;
  p95_first_audio_ms: string | number | null;
  deleted_by_retention: string | number;
};

function asArray<T>(value: unknown) {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseStats(value: unknown): PostgresAdminOverviewSnapshot["stats"] {
  const input = value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

  return {
    total: asNumber(input.total),
    unreviewed: asNumber(input.unreviewed),
    approved: asNumber(input.approved),
    rejected: asNumber(input.rejected),
    needsReview: asNumber(input.needsReview),
    aiSuggested: asNumber(input.aiSuggested),
    learned: asNumber(input.learned),
  };
}

/**
 * Loads only the conversations visible on the current admin page. Counts and
 * latency health are aggregated inside PostgreSQL so hundreds of complete
 * JSON records are not transferred to the Next.js process every refresh.
 */
export async function readPostgresAdminOverviewSnapshot(options: {
  clientId?: string;
  status: AdminReviewFilter;
  limit: number | null;
}): Promise<PostgresAdminOverviewSnapshot> {
  const params: unknown[] = [options.clientId ?? null, options.status];
  const limitClause = options.limit === null
    ? ""
    : `LIMIT $${params.push(options.limit)}::integer`;
  const rows = await queryDatabase<SnapshotRow>(
    `WITH history AS (
       SELECT COALESCE(
                NULLIF(BTRIM(value->>'clientId'), ''),
                'legacy'
              ) AS resolved_client_id,
              created_at,
              value,
              CASE
                WHEN NULLIF(value->>'reviewStatus', '') IS NOT NULL
                  THEN value->>'reviewStatus'
                WHEN value->'qualityApproved' = 'true'::jsonb
                  THEN 'approved'
                WHEN value->'qualityApproved' = 'false'::jsonb
                  THEN 'rejected'
                ELSE 'unreviewed'
              END AS review_status,
              CASE
                WHEN value->'aiReview' IS NOT NULL
                  AND value->'aiReview' <> 'null'::jsonb
                  THEN TRUE
                ELSE FALSE
              END AS has_ai_review,
              CASE
                WHEN COALESCE(value->'latency'->>'audioStartedAfterStopMs', '')
                       ~ '^[0-9]+([.][0-9]+)?$'
                  THEN (value->'latency'->>'audioStartedAfterStopMs')::double precision
                WHEN COALESCE(value->'latency'->>'browserAudioStartedMs', '')
                       ~ '^[0-9]+([.][0-9]+)?$'
                  THEN (value->'latency'->>'browserAudioStartedMs')::double precision
                WHEN COALESCE(value->'latency'->>'timeToFirstAudioMs', '')
                       ~ '^[0-9]+([.][0-9]+)?$'
                  THEN (value->'latency'->>'timeToFirstAudioMs')::double precision
                ELSE NULL
              END AS measured_first_audio_ms
         FROM app_records
        WHERE namespace = 'conversation_history'
          AND (expires_at IS NULL OR expires_at > NOW())
     ),
     scoped AS (
       SELECT *
         FROM history
        WHERE $1::text IS NULL OR resolved_client_id = $1::text
     ),
     visible AS (
       SELECT value, created_at
         FROM scoped
         WHERE $2::text = 'all'
            OR ($2::text = 'ai_suggested' AND has_ai_review)
            OR ($2::text NOT IN ('all', 'ai_suggested') AND review_status = $2::text)
         ORDER BY created_at DESC
         ${limitClause}
     ),
     device_rollup AS (
       SELECT resolved_client_id,
              COUNT(*)::integer AS conversation_count,
              COUNT(*) FILTER (WHERE review_status = 'unreviewed')::integer
                AS unreviewed_count,
              COUNT(*) FILTER (WHERE review_status = 'approved')::integer
                AS approved_count,
              COUNT(*) FILTER (WHERE review_status = 'rejected')::integer
                AS rejected_count,
              MAX(created_at) AS last_seen_at
         FROM history
        GROUP BY resolved_client_id
     )
     SELECT COALESCE(
              (SELECT jsonb_agg(value ORDER BY created_at DESC) FROM visible),
              '[]'::jsonb
            ) AS conversations,
            COALESCE(
              (SELECT jsonb_agg(value - 'hardware' ORDER BY created_at DESC)
                 FROM app_records
                WHERE namespace = 'device_profiles'
                  AND (expires_at IS NULL OR expires_at > NOW())),
              '[]'::jsonb
            ) AS profiles,
            COALESCE(
              (SELECT jsonb_agg(
                        jsonb_build_object(
                          'clientId', resolved_client_id,
                          'conversationCount', conversation_count,
                          'unreviewedCount', unreviewed_count,
                          'approvedCount', approved_count,
                          'rejectedCount', rejected_count,
                          'lastSeenAt', last_seen_at
                        )
                        ORDER BY last_seen_at DESC
                      )
                 FROM device_rollup),
              '[]'::jsonb
            ) AS device_counts,
            (SELECT jsonb_build_object(
                      'total', COUNT(*),
                      'unreviewed', COUNT(*) FILTER (WHERE review_status = 'unreviewed'),
                      'approved', COUNT(*) FILTER (WHERE review_status = 'approved'),
                      'rejected', COUNT(*) FILTER (WHERE review_status = 'rejected'),
                      'needsReview', COUNT(*) FILTER (
                        WHERE review_status = 'needs_review'
                           OR value->'aiReview'->>'verdict' = 'needs_review'
                      ),
                      'aiSuggested', COUNT(*) FILTER (WHERE has_ai_review),
                      'learned', COUNT(*) FILTER (WHERE value->>'promotedToRule' = 'true')
                    )
               FROM scoped) AS stats,
            (SELECT COUNT(*)
               FROM scoped
              WHERE measured_first_audio_ms >= 20) AS latency_sample_count,
            (SELECT percentile_disc(0.95) WITHIN GROUP (
                      ORDER BY measured_first_audio_ms
                    )
               FROM scoped
              WHERE measured_first_audio_ms >= 20) AS p95_first_audio_ms,
            0 AS deleted_by_retention`,
    params,
  );
  const row = rows[0];

  return {
    conversations: asArray<ConversationHistoryEntry>(row?.conversations),
    profiles: asArray<DeviceProfile>(row?.profiles),
    deviceCounts: asArray<DeviceCounts>(row?.device_counts).map((device) => ({
      ...device,
      conversationCount: asNumber(device.conversationCount),
      unreviewedCount: asNumber(device.unreviewedCount),
      approvedCount: asNumber(device.approvedCount),
      rejectedCount: asNumber(device.rejectedCount),
      lastSeenAt: device.lastSeenAt
        ? new Date(device.lastSeenAt).toISOString()
        : undefined,
    })),
    stats: parseStats(row?.stats),
    latencySampleCount: asNumber(row?.latency_sample_count),
    p95FirstAudioMs: Math.round(asNumber(row?.p95_first_audio_ms)),
    deletedByRetention: asNumber(row?.deleted_by_retention),
  };
}
