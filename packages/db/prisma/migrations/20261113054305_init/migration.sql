-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'PENDING_DELETION', 'DELETED');

-- CreateEnum
CREATE TYPE "OrgStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'PENDING_DELETION');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'ADMIN_OPERATOR', 'ADMIN_BILLING', 'ADMIN_SUPPORT', 'ADMIN_AUDITOR');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DomainPolicy" AS ENUM ('ROOT_EXCLUSIVE', 'SUBDOMAIN_INDEPENDENT');

-- CreateEnum
CREATE TYPE "ClaimScope" AS ENUM ('ROOT', 'HOST');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('PENDING', 'VERIFIED', 'LAPSED', 'EXPIRED', 'RELEASED', 'TRANSFERRED_OUT', 'REJECTED');

-- CreateEnum
CREATE TYPE "VerificationMethod" AS ENUM ('DNS_TXT', 'HTML_META', 'WELL_KNOWN_FILE', 'SDK_BEACON');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('PENDING_VERIFICATION', 'PENDING_ADMIN', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WebsiteStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'PAUSED', 'SUSPENDED', 'LAPSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "InstallationStatus" AS ENUM ('NOT_DETECTED', 'DETECTED', 'STALE');

-- CreateEnum
CREATE TYPE "CheckTier" AS ENUM ('T1_HTTP', 'T2_RENDER', 'T3_DEEP', 'API', 'SSL', 'VERIFY', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DISABLED');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ResultStatus" AS ENUM ('PASSED', 'FAILED', 'SKIPPED', 'INCONCLUSIVE', 'DETECTED_NOT_TESTED');

-- CreateEnum
CREATE TYPE "PageStatus" AS ENUM ('ACTIVE', 'STALE', 'EXCLUDED', 'REMOVED');

-- CreateEnum
CREATE TYPE "ComponentType" AS ENUM ('HEADER', 'NAV', 'FOOTER', 'SEARCH', 'FORM', 'BUTTON', 'LINK', 'IMAGE', 'DROPDOWN', 'MODAL', 'TABS', 'ACCORDION', 'SLIDER', 'PAGINATION', 'TABLE', 'RESPONSIVE_NAV', 'CUSTOM');

-- CreateEnum
CREATE TYPE "TestSafety" AS ENUM ('SAFE', 'REQUIRES_APPROVAL');

-- CreateEnum
CREATE TYPE "HttpMethod" AS ENUM ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD');

-- CreateEnum
CREATE TYPE "ApiAuthType" AS ENUM ('NONE', 'BEARER', 'BASIC', 'API_KEY_HEADER', 'API_KEY_QUERY', 'OAUTH2_CLIENT_CREDENTIALS');

-- CreateEnum
CREATE TYPE "HostAuthorization" AS ENUM ('VERIFIED_DOMAIN', 'HOST_VERIFIED', 'ALLOWLISTED', 'PENDING');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'REOPENED', 'IGNORED');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');

-- CreateEnum
CREATE TYPE "IncidentCategory" AS ENUM ('AVAILABILITY', 'HTTP_ERROR', 'SSL', 'JS_ERROR', 'RESOURCE', 'PERFORMANCE', 'COMPONENT', 'FUNCTIONAL', 'RESPONSIVE', 'API_ASSERTION', 'SEARCH', 'FORM', 'SYSTEM');

-- CreateEnum
CREATE TYPE "SignalSource" AS ENUM ('HTTP_PROBE', 'API_CHECK', 'BROWSER', 'SDK', 'SSL', 'SYSTEM');

-- CreateEnum
CREATE TYPE "IncidentEventType" AS ENUM ('CREATED', 'OCCURRED', 'ACKNOWLEDGED', 'INVESTIGATING', 'ESCALATED', 'SEVERITY_CHANGED', 'RESOLVED', 'AUTO_RESOLVED', 'REOPENED', 'IGNORED', 'UNIGNORED', 'COMMENTED', 'FLAPPING_STARTED', 'FLAPPING_ENDED');

-- CreateEnum
CREATE TYPE "ChannelKind" AS ENUM ('EMAIL', 'IN_APP', 'SLACK', 'TEAMS', 'SMS', 'WHATSAPP', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'FAILED', 'BOUNCED', 'SUPPRESSED', 'DEDUPED');

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTH', 'YEAR');

-- CreateEnum
CREATE TYPE "GatewayKind" AS ENUM ('STRIPE', 'RAZORPAY');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELING', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TrialStatus" AS ENUM ('ACTIVE', 'CONVERTED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE');

-- CreateEnum
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'ADMIN', 'SYSTEM', 'API_KEY');

-- CreateEnum
CREATE TYPE "BreakGlassStatus" AS ENUM ('REQUESTED', 'AWAITING_CUSTOMER', 'APPROVED', 'ACTIVE', 'EXPIRED', 'REJECTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ReportFormat" AS ENUM ('PDF', 'CSV');

-- CreateEnum
CREATE TYPE "JobState" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "SettingScope" AS ENUM ('PLATFORM', 'ORG', 'WEBSITE');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" CITEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(6),
    "password_hash" TEXT NOT NULL,
    "name" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "totp_secret_enc" BYTEA,
    "totp_enabled_at" TIMESTAMPTZ(6),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "password_changed_at" TIMESTAMPTZ(6),
    "deletion_requested_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "csrf_secret" TEXT NOT NULL,
    "ip_prefix" TEXT,
    "user_agent" TEXT,
    "mfa_verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" "ActorType" NOT NULL,
    "user_id" UUID,
    "email_hash" TEXT NOT NULL,
    "ip_prefix" TEXT,
    "success" BOOLEAN NOT NULL,
    "reason" TEXT,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id","occurred_at")
) PARTITION BY RANGE ("occurred_at");

-- CreateTable
CREATE TABLE "admin_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL,
    "totp_secret_enc" BYTEA NOT NULL,
    "webauthn" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(6),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "admin_user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "csrf_secret" TEXT NOT NULL,
    "ip_prefix" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "OrgStatus" NOT NULL DEFAULT 'ACTIVE',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "support_access" TEXT NOT NULL DEFAULT 'REQUIRE_CUSTOMER_CONSENT',
    "suspended_reason" TEXT,
    "deletion_requested_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_key" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_key")
);

-- CreateTable
CREATE TABLE "organization_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "role_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "invited_by_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_encryption_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "kek_id" TEXT NOT NULL,
    "wrapped_dek" BYTEA NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMPTZ(6),

    CONSTRAINT "org_encryption_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_registry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "identity_key" TEXT NOT NULL,
    "host_key" TEXT NOT NULL,
    "registrable_domain" TEXT NOT NULL,
    "display_host" TEXT NOT NULL,
    "is_root" BOOLEAN NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "first_verified_at" TIMESTAMPTZ(6),
    "blocked" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "domain_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_claims" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "domain_registry_id" UUID NOT NULL,
    "org_id" UUID,
    "scope" "ClaimScope" NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'PENDING',
    "policy" "DomainPolicy" NOT NULL,
    "verification_token" TEXT NOT NULL,
    "pending_expires_at" TIMESTAMPTZ(6),
    "verified_at" TIMESTAMPTZ(6),
    "last_reverified_at" TIMESTAMPTZ(6),
    "lapsed_at" TIMESTAMPTZ(6),
    "released_at" TIMESTAMPTZ(6),
    "release_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "domain_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_verifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "domain_claim_id" UUID NOT NULL,
    "method" "VerificationMethod" NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "detail" JSONB,
    "failure_reason" TEXT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "is_reverification" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "domain_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_registration_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "domain_registry_id" UUID,
    "org_id" UUID,
    "input_host" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_registration_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_transfers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "domain_registry_id" UUID NOT NULL,
    "from_claim_id" UUID,
    "to_org_id" UUID,
    "to_claim_id" UUID,
    "status" "TransferStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "owner_response" TEXT,
    "owner_respond_by" TIMESTAMPTZ(6),
    "decided_by_admin_id" UUID,
    "decision_reason" TEXT,
    "auto_approved" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(6),

    CONSTRAINT "domain_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_trial_ledger" (
    "registrable_domain" TEXT NOT NULL,
    "first_registered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "first_verified_at" TIMESTAMPTZ(6),
    "trial_consumed_at" TIMESTAMPTZ(6),
    "trial_count" INTEGER NOT NULL DEFAULT 0,
    "registration_count" INTEGER NOT NULL DEFAULT 0,
    "last_released_at" TIMESTAMPTZ(6),
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "admin_reset_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "domain_trial_ledger_pkey" PRIMARY KEY ("registrable_domain")
);

-- CreateTable
CREATE TABLE "abuse_signals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL,
    "value_hash" TEXT NOT NULL,
    "trial_used_at" TIMESTAMPTZ(6),
    "seen_count" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "abuse_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocked_domains" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pattern" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocked_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_policy_suffixes" (
    "suffix" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_policy_suffixes_pkey" PRIMARY KEY ("suffix")
);

-- CreateTable
CREATE TABLE "api_host_authorizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID,
    "host" TEXT NOT NULL,
    "kind" "HostAuthorization" NOT NULL,
    "verification_token" TEXT,
    "verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_host_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "websites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "domain_claim_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "canonical_origin" TEXT NOT NULL,
    "status" "WebsiteStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "paused_at" TIMESTAMPTZ(6),
    "suspended_reason" TEXT,
    "health_score" INTEGER,
    "health_band" TEXT,
    "last_checked_at" TIMESTAMPTZ(6),
    "current_state" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "websites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_installations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "site_key" TEXT NOT NULL,
    "previous_site_key" TEXT,
    "previous_key_expires_at" TIMESTAMPTZ(6),
    "status" "InstallationStatus" NOT NULL DEFAULT 'NOT_DETECTED',
    "sdk_version" TEXT,
    "first_seen_at" TIMESTAMPTZ(6),
    "last_seen_at" TIMESTAMPTZ(6),
    "sdk_config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "site_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitoring_configurations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "t1_interval_sec" INTEGER NOT NULL DEFAULT 300,
    "t2_interval_sec" INTEGER,
    "t3_interval_sec" INTEGER,
    "t1_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "viewports" JSONB NOT NULL DEFAULT '[{"name":"desktop","width":1366,"height":768}]',
    "max_pages" INTEGER NOT NULL DEFAULT 25,
    "max_depth" INTEGER NOT NULL DEFAULT 3,
    "include_patterns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "exclude_patterns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "query_param_mode" TEXT NOT NULL DEFAULT 'IGNORE_ALL',
    "query_param_allowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "respect_robots" BOOLEAN NOT NULL DEFAULT true,
    "performance_thresholds" JSONB NOT NULL DEFAULT '{}',
    "component_selectors" JSONB NOT NULL DEFAULT '{}',
    "keyword_checks" JSONB NOT NULL DEFAULT '[]',
    "store_response_samples" BOOLEAN NOT NULL DEFAULT false,
    "capture_artifacts_on" TEXT NOT NULL DEFAULT 'FAILURE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "monitoring_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_windows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "website_id" UUID,
    "name" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "rrule" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_recipes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "login_url" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "credentials_enc" BYTEA NOT NULL,
    "key_version" INTEGER NOT NULL,
    "success_selector" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "auth_recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovered_pages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "url_hash" TEXT NOT NULL,
    "path_template" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "status" "PageStatus" NOT NULL DEFAULT 'ACTIVE',
    "title" TEXT,
    "content_hash" TEXT,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "missed_crawls" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "discovered_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitored_pages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "discovered_page_id" UUID NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "t2_enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" "PageStatus" NOT NULL DEFAULT 'ACTIVE',
    "current_state" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "last_result_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monitored_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_components" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "monitored_page_id" UUID NOT NULL,
    "type" "ComponentType" NOT NULL,
    "selector" TEXT NOT NULL,
    "dom_path_hash" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidence" JSONB NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_cases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "builtin_key" TEXT,
    "applies_to" JSONB NOT NULL,
    "steps" JSONB NOT NULL,
    "assertions" JSONB NOT NULL,
    "safety" "TestSafety" NOT NULL DEFAULT 'SAFE',
    "steps_hash" TEXT NOT NULL,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "approved_hash" TEXT,
    "allowed_hosts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "auth_recipe_id" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "test_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitoring_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "api_endpoint_id" UUID,
    "tier" "CheckTier" NOT NULL,
    "interval_sec" INTEGER NOT NULL,
    "jitter_sec" INTEGER NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "region" TEXT NOT NULL DEFAULT 'r1',
    "status" "ScheduleStatus" NOT NULL DEFAULT 'ACTIVE',
    "next_run_at" TIMESTAMPTZ(6) NOT NULL,
    "last_enqueued_at" TIMESTAMPTZ(6),
    "missed_slots" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "monitoring_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitoring_executions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "schedule_id" UUID,
    "slot" BIGINT,
    "api_endpoint_id" UUID,
    "tier" "CheckTier" NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'SCHEDULE',
    "region" TEXT NOT NULL DEFAULT 'r1',
    "status" "ExecutionStatus" NOT NULL DEFAULT 'QUEUED',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "worker_id" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "duration_ms" INTEGER,
    "config_version" INTEGER,
    "suppress_alerts" BOOLEAN NOT NULL DEFAULT false,
    "summary" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,

    CONSTRAINT "monitoring_executions_pkey" PRIMARY KEY ("id","queued_at")
) PARTITION BY RANGE ("queued_at");

-- CreateTable
CREATE TABLE "check_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "checked_at" TIMESTAMPTZ(6) NOT NULL,
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "status" "ResultStatus" NOT NULL,
    "failure_kind" TEXT,
    "http_status" INTEGER,
    "redirect_chain" JSONB,
    "dns_ms" INTEGER,
    "connect_ms" INTEGER,
    "tls_ms" INTEGER,
    "ttfb_ms" INTEGER,
    "total_ms" INTEGER,
    "bytes" INTEGER,
    "resolved_ip" INET,
    "ssl_expires_at" TIMESTAMPTZ(6),
    "ssl_issuer" TEXT,
    "ssl_valid" BOOLEAN,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "region" TEXT NOT NULL DEFAULT 'r1',

    CONSTRAINT "check_results_pkey" PRIMARY KEY ("id","checked_at")
) PARTITION BY RANGE ("checked_at");

-- CreateTable
CREATE TABLE "page_test_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tested_at" TIMESTAMPTZ(6) NOT NULL,
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "monitored_page_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "tier" "CheckTier" NOT NULL,
    "viewport" TEXT NOT NULL,
    "status" "ResultStatus" NOT NULL,
    "http_status" INTEGER,
    "blank_page" BOOLEAN NOT NULL DEFAULT false,
    "js_error_count" INTEGER NOT NULL DEFAULT 0,
    "console_error_count" INTEGER NOT NULL DEFAULT 0,
    "failed_request_count" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "load_ms" INTEGER,
    "artifact_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "page_test_results_pkey" PRIMARY KEY ("id","tested_at")
) PARTITION BY RANGE ("tested_at");

-- CreateTable
CREATE TABLE "component_test_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tested_at" TIMESTAMPTZ(6) NOT NULL,
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "monitored_page_id" UUID NOT NULL,
    "page_component_id" UUID,
    "test_case_id" UUID,
    "execution_id" UUID NOT NULL,
    "component_type" "ComponentType" NOT NULL,
    "viewport" TEXT NOT NULL,
    "status" "ResultStatus" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "coverage_note" TEXT,
    "steps" JSONB,
    "failure_reason" TEXT,
    "artifact_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "component_test_results_pkey" PRIMARY KEY ("id","tested_at")
) PARTITION BY RANGE ("tested_at");

-- CreateTable
CREATE TABLE "responsive_test_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tested_at" TIMESTAMPTZ(6) NOT NULL,
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "monitored_page_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "viewport" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "status" "ResultStatus" NOT NULL,
    "horizontal_overflow_px" INTEGER NOT NULL DEFAULT 0,
    "offscreen_elements" INTEGER NOT NULL DEFAULT 0,
    "overlaps" INTEGER NOT NULL DEFAULT 0,
    "clipped_text" INTEGER NOT NULL DEFAULT 0,
    "oversized_images" INTEGER NOT NULL DEFAULT 0,
    "nav_state" TEXT,
    "findings" JSONB,
    "artifact_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "responsive_test_results_pkey" PRIMARY KEY ("id","tested_at")
) PARTITION BY RANGE ("tested_at");

-- CreateTable
CREATE TABLE "performance_metrics" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "measured_at" TIMESTAMPTZ(6) NOT NULL,
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "monitored_page_id" UUID NOT NULL,
    "execution_id" UUID,
    "source" TEXT NOT NULL DEFAULT 'SYNTHETIC',
    "viewport" TEXT NOT NULL,
    "fcp_ms" INTEGER,
    "lcp_ms" INTEGER,
    "cls" DOUBLE PRECISION,
    "inp_ms" INTEGER,
    "tbt_ms" INTEGER,
    "ttfb_ms" INTEGER,
    "load_ms" INTEGER,
    "transfer_bytes" INTEGER,
    "request_count" INTEGER,
    "slowest_resources" JSONB,

    CONSTRAINT "performance_metrics_pkey" PRIMARY KEY ("id","measured_at")
) PARTITION BY RANGE ("measured_at");

-- CreateTable
CREATE TABLE "artifacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "website_id" UUID,
    "execution_id" UUID,
    "kind" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_endpoints" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "method" "HttpMethod" NOT NULL,
    "url" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "host_authorization" "HostAuthorization" NOT NULL,
    "query_params" JSONB NOT NULL DEFAULT '{}',
    "headers" JSONB NOT NULL DEFAULT '{}',
    "body_type" TEXT,
    "body" TEXT,
    "expected_status" INTEGER[] DEFAULT ARRAY[200]::INTEGER[],
    "assertions" JSONB NOT NULL DEFAULT '[]',
    "response_time_threshold_ms" INTEGER NOT NULL DEFAULT 1000,
    "timeout_ms" INTEGER NOT NULL DEFAULT 10000,
    "interval_sec" INTEGER NOT NULL,
    "retry_count" INTEGER NOT NULL DEFAULT 1,
    "retry_delay_ms" INTEGER NOT NULL DEFAULT 5000,
    "mutation_acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "current_state" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "last_checked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "api_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_credentials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "api_endpoint_id" UUID NOT NULL,
    "auth_type" "ApiAuthType" NOT NULL,
    "secret_enc" BYTEA NOT NULL,
    "key_version" INTEGER NOT NULL,
    "hint" TEXT,
    "rotated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "api_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_test_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "checked_at" TIMESTAMPTZ(6) NOT NULL,
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "api_endpoint_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "status" "ResultStatus" NOT NULL,
    "http_status" INTEGER,
    "failure_kind" TEXT,
    "response_time_ms" INTEGER,
    "response_bytes" INTEGER,
    "assertion_results" JSONB NOT NULL,
    "response_headers" JSONB,
    "body_sample" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "region" TEXT NOT NULL DEFAULT 'r1',

    CONSTRAINT "api_test_results_pkey" PRIMARY KEY ("id","checked_at")
) PARTITION BY RANGE ("checked_at");

-- CreateTable
CREATE TABLE "sdk_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "fingerprint" TEXT,
    "page_path" TEXT NOT NULL,
    "session_ref" TEXT,
    "device_type" TEXT,
    "browser" TEXT,
    "os" TEXT,
    "viewport_w" INTEGER,
    "viewport_h" INTEGER,
    "sdk_version" TEXT,
    "payload" JSONB NOT NULL,

    CONSTRAINT "sdk_events_pkey" PRIMARY KEY ("id","received_at")
) PARTITION BY RANGE ("received_at");

-- CreateTable
CREATE TABLE "metrics_hourly" (
    "bucket" TIMESTAMPTZ(6) NOT NULL,
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "ok_count" INTEGER NOT NULL,
    "sum" DOUBLE PRECISION NOT NULL,
    "min" DOUBLE PRECISION,
    "max" DOUBLE PRECISION,
    "p50" DOUBLE PRECISION,
    "p95" DOUBLE PRECISION,
    "digest" BYTEA,
    "histogram" JSONB,

    CONSTRAINT "metrics_hourly_pkey" PRIMARY KEY ("bucket","org_id","subject_type","subject_id","metric")
) PARTITION BY RANGE ("bucket");

-- CreateTable
CREATE TABLE "metrics_daily" (
    "bucket" DATE NOT NULL,
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "ok_count" INTEGER NOT NULL,
    "sum" DOUBLE PRECISION NOT NULL,
    "min" DOUBLE PRECISION,
    "max" DOUBLE PRECISION,
    "p50" DOUBLE PRECISION,
    "p95" DOUBLE PRECISION,
    "digest" BYTEA,
    "histogram" JSONB,
    "downtime_sec" INTEGER,

    CONSTRAINT "metrics_daily_pkey" PRIMARY KEY ("bucket","org_id","subject_type","subject_id","metric")
) PARTITION BY RANGE ("bucket");

-- CreateTable
CREATE TABLE "website_health_scores" (
    "computed_at" TIMESTAMPTZ(6) NOT NULL,
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "score" INTEGER,
    "band" TEXT NOT NULL,
    "components" JSONB NOT NULL,
    "coverage_pct" INTEGER NOT NULL,
    "config_version" INTEGER NOT NULL,
    "capped_by" TEXT,

    CONSTRAINT "website_health_scores_pkey" PRIMARY KEY ("website_id","computed_at")
) PARTITION BY RANGE ("computed_at");

-- CreateTable
CREATE TABLE "incident_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID,
    "website_id" UUID,
    "category" "IncidentCategory" NOT NULL,
    "failure_threshold" INTEGER NOT NULL DEFAULT 2,
    "window_sec" INTEGER NOT NULL DEFAULT 300,
    "consecutive" BOOLEAN NOT NULL DEFAULT true,
    "severity" "Severity" NOT NULL,
    "reopen_window_sec" INTEGER NOT NULL DEFAULT 86400,
    "recovery_passes" INTEGER NOT NULL DEFAULT 2,
    "escalate_after_sec" INTEGER,
    "escalate_to_severity" "Severity",
    "flap_threshold" INTEGER NOT NULL DEFAULT 4,
    "flap_window_sec" INTEGER NOT NULL DEFAULT 3600,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "incident_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incidents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "number" INTEGER NOT NULL,
    "org_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "monitored_page_id" UUID,
    "api_endpoint_id" UUID,
    "fingerprint" TEXT NOT NULL,
    "check_key" TEXT NOT NULL,
    "category" "IncidentCategory" NOT NULL,
    "source" "SignalSource" NOT NULL,
    "severity" "Severity" NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "diagnostics" JSONB NOT NULL,
    "occurrence_count" INTEGER NOT NULL DEFAULT 1,
    "first_detected_at" TIMESTAMPTZ(6) NOT NULL,
    "last_detected_at" TIMESTAMPTZ(6) NOT NULL,
    "acknowledged_at" TIMESTAMPTZ(6),
    "acknowledged_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by_id" UUID,
    "auto_resolved" BOOLEAN NOT NULL DEFAULT false,
    "reopen_count" INTEGER NOT NULL DEFAULT 0,
    "flapping" BOOLEAN NOT NULL DEFAULT false,
    "in_maintenance" BOOLEAN NOT NULL DEFAULT false,
    "ignored_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_occurrences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "org_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "execution_id" UUID,
    "page_url" TEXT,
    "viewport" TEXT,
    "region" TEXT,
    "details" JSONB NOT NULL,
    "artifact_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "incident_occurrences_pkey" PRIMARY KEY ("id","occurred_at")
) PARTITION BY RANGE ("occurred_at");

-- CreateTable
CREATE TABLE "incident_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "type" "IncidentEventType" NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" UUID,
    "from_status" "IncidentStatus",
    "to_status" "IncidentStatus",
    "data" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "incident_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" BIGSERIAL NOT NULL,
    "org_id" UUID,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "Severity",
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "incident_id" UUID,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" "ChannelKind" NOT NULL,
    "min_severity" "Severity" NOT NULL DEFAULT 'MEDIUM',
    "event_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "website_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "digest" TEXT NOT NULL DEFAULT 'IMMEDIATE',
    "quiet_hours" JSONB,
    "sound_enabled" BOOLEAN NOT NULL DEFAULT true,
    "sound_min_severity" "Severity" NOT NULL DEFAULT 'HIGH',
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_channels" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "kind" "ChannelKind" NOT NULL,
    "name" TEXT NOT NULL,
    "target" TEXT,
    "config_enc" BYTEA,
    "key_version" INTEGER,
    "min_severity" "Severity" NOT NULL DEFAULT 'HIGH',
    "verified_at" TIMESTAMPTZ(6),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_delivery_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "org_id" UUID,
    "channel" "ChannelKind" NOT NULL,
    "recipient_ref" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "incident_id" UUID,
    "idempotency_key" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "provider_message_id" TEXT,
    "last_error" TEXT,
    "sent_at" TIMESTAMPTZ(6),

    CONSTRAINT "notification_delivery_logs_pkey" PRIMARY KEY ("id","created_at")
) PARTITION BY RANGE ("created_at");

-- CreateTable
CREATE TABLE "email_suppressions" (
    "email_hash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("email_hash")
);

-- CreateTable
CREATE TABLE "email_templates" (
    "key" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body_mjml" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "email_templates_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "subscription_plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "trial_eligible" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_prices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "plan_id" UUID NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "stripe_price_id" TEXT,
    "razorpay_plan_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_entitlements" (
    "plan_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "plan_entitlements_pkey" PRIMARY KEY ("plan_id","key")
);

-- CreateTable
CREATE TABLE "entitlement_overrides" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entitlement_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "plan_price_id" UUID,
    "plan_id" UUID NOT NULL,
    "gateway" "GatewayKind",
    "gateway_subscription_id" TEXT,
    "status" "SubscriptionStatus" NOT NULL,
    "current_period_start" TIMESTAMPTZ(6),
    "current_period_end" TIMESTAMPTZ(6),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "canceled_at" TIMESTAMPTZ(6),
    "grace_ends_at" TIMESTAMPTZ(6),
    "pending_plan_price_id" UUID,
    "gateway_updated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "registrable_domain" TEXT NOT NULL,
    "status" "TrialStatus" NOT NULL DEFAULT 'ACTIVE',
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "extended_days" INTEGER NOT NULL DEFAULT 0,
    "extended_by_id" UUID,
    "risk_score" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_customers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "gateway" "GatewayKind" NOT NULL,
    "gateway_customer_id" TEXT NOT NULL,
    "default_payment_method" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "subscription_id" UUID,
    "invoice_id" UUID,
    "gateway" "GatewayKind" NOT NULL,
    "gateway_payment_id" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "failure_code" TEXT,
    "failure_message" TEXT,
    "refunded_minor" INTEGER NOT NULL DEFAULT 0,
    "paid_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "subscription_id" UUID,
    "number" TEXT NOT NULL,
    "gateway" "GatewayKind",
    "gateway_invoice_id" TEXT,
    "status" "InvoiceStatus" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "subtotal_minor" INTEGER NOT NULL,
    "tax_minor" INTEGER NOT NULL DEFAULT 0,
    "total_minor" INTEGER NOT NULL,
    "tax_details" JSONB,
    "billing_details" JSONB,
    "period_start" TIMESTAMPTZ(6),
    "period_end" TIMESTAMPTZ(6),
    "pdf_artifact_id" UUID,
    "issued_at" TIMESTAMPTZ(6) NOT NULL,
    "paid_at" TIMESTAMPTZ(6),

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_webhook_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "gateway" "GatewayKind" NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "signature_valid" BOOLEAN NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_gateway_configs" (
    "gateway" "GatewayKind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'test',
    "public_key" TEXT,
    "secrets_enc" BYTEA,
    "key_version" INTEGER,
    "secret_hint" TEXT,
    "currencies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "settings" JSONB NOT NULL DEFAULT '{}',
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payment_gateway_configs_pkey" PRIMARY KEY ("gateway")
);

-- CreateTable
CREATE TABLE "usage_counters" (
    "org_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "key" TEXT NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("org_id","period_start","key")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "stream" TEXT NOT NULL,
    "seq" BIGINT NOT NULL DEFAULT 0,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "org_id" UUID,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" UUID,
    "actor_label" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "ip_prefix" TEXT,
    "request_id" TEXT,
    "changes" JSONB,
    "reason" TEXT,
    "prev_hash" TEXT NOT NULL DEFAULT '',
    "hash" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_anchors" (
    "id" BIGSERIAL NOT NULL,
    "stream" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "hash" TEXT NOT NULL,
    "exported_to" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_anchors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "org_id" UUID,
    "actor_ref" TEXT,
    "ip_prefix" TEXT,
    "details" JSONB NOT NULL,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id","occurred_at")
) PARTITION BY RANGE ("occurred_at");

-- CreateTable
CREATE TABLE "break_glass_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "approved_by_id" UUID,
    "customer_approved_by_id" UUID,
    "purpose" TEXT NOT NULL,
    "ticket_ref" TEXT NOT NULL,
    "scope" TEXT[],
    "status" "BreakGlassStatus" NOT NULL DEFAULT 'REQUESTED',
    "duration_min" INTEGER NOT NULL,
    "activated_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "break_glass_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "scope" "SettingScope" NOT NULL DEFAULT 'PLATFORM',
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "platform_setting_history" (
    "id" BIGSERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_setting_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "rollout_pct" INTEGER NOT NULL DEFAULT 0,
    "org_allowlist" UUID[] DEFAULT ARRAY[]::UUID[],
    "plan_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "worker_heartbeats" (
    "worker_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "active_jobs" INTEGER NOT NULL,
    "capacity" INTEGER NOT NULL,
    "rss_mb" INTEGER,
    "is_leader" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("worker_id")
);

-- CreateTable
CREATE TABLE "system_health_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "component" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "labels" JSONB,

    CONSTRAINT "system_health_logs_pkey" PRIMARY KEY ("id","recorded_at")
) PARTITION BY RANGE ("recorded_at");

-- CreateTable
CREATE TABLE "job_failures" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "queue" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "org_id" UUID,
    "payload" JSONB NOT NULL,
    "error" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "failed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolution" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by_id" UUID,

    CONSTRAINT "job_failures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "format" "ReportFormat" NOT NULL,
    "params" JSONB NOT NULL,
    "state" "JobState" NOT NULL DEFAULT 'QUEUED',
    "artifact_id" UUID,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "report_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL,
    "org_id" UUID,
    "user_id" UUID,
    "state" "JobState" NOT NULL DEFAULT 'QUEUED',
    "scheduled_for" TIMESTAMPTZ(6),
    "artifact_id" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_token_hash_key" ON "user_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "user_sessions_user_id_revoked_at_idx" ON "user_sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "user_sessions_expires_at_idx" ON "user_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "recovery_codes_user_id_idx" ON "recovery_codes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key" ON "email_verification_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "login_attempts_email_hash_occurred_at_idx" ON "login_attempts"("email_hash", "occurred_at");

-- CreateIndex
CREATE INDEX "login_attempts_user_id_occurred_at_idx" ON "login_attempts"("user_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "admin_sessions_token_hash_key" ON "admin_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "admin_sessions_admin_user_id_idx" ON "admin_sessions"("admin_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "roles_org_id_key_key" ON "roles"("org_id", "key");

-- CreateIndex
CREATE INDEX "organization_members_user_id_idx" ON "organization_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_members_org_id_user_id_key" ON "organization_members"("org_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_org_id_status_idx" ON "invitations"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "org_encryption_keys_org_id_version_key" ON "org_encryption_keys"("org_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "domain_registry_identity_key_key" ON "domain_registry"("identity_key");

-- CreateIndex
CREATE INDEX "domain_registry_registrable_domain_idx" ON "domain_registry"("registrable_domain");

-- CreateIndex
CREATE INDEX "domain_claims_org_id_status_idx" ON "domain_claims"("org_id", "status");

-- CreateIndex
CREATE INDEX "domain_claims_status_pending_expires_at_idx" ON "domain_claims"("status", "pending_expires_at");

-- CreateIndex
CREATE INDEX "domain_verifications_domain_claim_id_requested_at_idx" ON "domain_verifications"("domain_claim_id", "requested_at");

-- CreateIndex
CREATE INDEX "domain_registration_attempts_domain_registry_id_created_at_idx" ON "domain_registration_attempts"("domain_registry_id", "created_at");

-- CreateIndex
CREATE INDEX "domain_registration_attempts_outcome_created_at_idx" ON "domain_registration_attempts"("outcome", "created_at");

-- CreateIndex
CREATE INDEX "domain_transfers_status_created_at_idx" ON "domain_transfers"("status", "created_at");

-- CreateIndex
CREATE INDEX "abuse_signals_expires_at_idx" ON "abuse_signals"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "abuse_signals_kind_value_hash_key" ON "abuse_signals"("kind", "value_hash");

-- CreateIndex
CREATE UNIQUE INDEX "blocked_domains_pattern_key" ON "blocked_domains"("pattern");

-- CreateIndex
CREATE UNIQUE INDEX "api_host_authorizations_org_id_host_key" ON "api_host_authorizations"("org_id", "host");

-- CreateIndex
CREATE UNIQUE INDEX "websites_domain_claim_id_key" ON "websites"("domain_claim_id");

-- CreateIndex
CREATE INDEX "websites_org_id_status_idx" ON "websites"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "site_installations_website_id_key" ON "site_installations"("website_id");

-- CreateIndex
CREATE UNIQUE INDEX "site_installations_site_key_key" ON "site_installations"("site_key");

-- CreateIndex
CREATE UNIQUE INDEX "monitoring_configurations_website_id_key" ON "monitoring_configurations"("website_id");

-- CreateIndex
CREATE INDEX "maintenance_windows_org_id_starts_at_ends_at_idx" ON "maintenance_windows"("org_id", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "discovered_pages_org_id_website_id_status_idx" ON "discovered_pages"("org_id", "website_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "discovered_pages_website_id_url_hash_key" ON "discovered_pages"("website_id", "url_hash");

-- CreateIndex
CREATE UNIQUE INDEX "monitored_pages_discovered_page_id_key" ON "monitored_pages"("discovered_page_id");

-- CreateIndex
CREATE INDEX "monitored_pages_org_id_website_id_status_idx" ON "monitored_pages"("org_id", "website_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "page_components_monitored_page_id_type_dom_path_hash_key" ON "page_components"("monitored_page_id", "type", "dom_path_hash");

-- CreateIndex
CREATE INDEX "test_cases_org_id_website_id_idx" ON "test_cases"("org_id", "website_id");

-- CreateIndex
CREATE INDEX "monitoring_schedules_status_next_run_at_idx" ON "monitoring_schedules"("status", "next_run_at");

-- CreateIndex
CREATE UNIQUE INDEX "monitoring_schedules_website_id_api_endpoint_id_tier_key" ON "monitoring_schedules"("website_id", "api_endpoint_id", "tier");

-- CreateIndex
CREATE INDEX "monitoring_executions_org_id_website_id_queued_at_idx" ON "monitoring_executions"("org_id", "website_id", "queued_at" DESC);

-- CreateIndex
CREATE INDEX "monitoring_executions_status_queued_at_idx" ON "monitoring_executions"("status", "queued_at");

-- CreateIndex
CREATE UNIQUE INDEX "monitoring_executions_schedule_id_slot_queued_at_key" ON "monitoring_executions"("schedule_id", "slot", "queued_at");

-- CreateIndex
CREATE INDEX "check_results_website_id_checked_at_idx" ON "check_results"("website_id", "checked_at" DESC);

-- CreateIndex
CREATE INDEX "page_test_results_monitored_page_id_tested_at_idx" ON "page_test_results"("monitored_page_id", "tested_at" DESC);

-- CreateIndex
CREATE INDEX "page_test_results_website_id_tested_at_idx" ON "page_test_results"("website_id", "tested_at" DESC);

-- CreateIndex
CREATE INDEX "component_test_results_monitored_page_id_tested_at_idx" ON "component_test_results"("monitored_page_id", "tested_at" DESC);

-- CreateIndex
CREATE INDEX "responsive_test_results_monitored_page_id_tested_at_idx" ON "responsive_test_results"("monitored_page_id", "tested_at" DESC);

-- CreateIndex
CREATE INDEX "performance_metrics_monitored_page_id_measured_at_idx" ON "performance_metrics"("monitored_page_id", "measured_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "artifacts_storage_key_key" ON "artifacts"("storage_key");

-- CreateIndex
CREATE INDEX "artifacts_org_id_execution_id_idx" ON "artifacts"("org_id", "execution_id");

-- CreateIndex
CREATE INDEX "artifacts_expires_at_idx" ON "artifacts"("expires_at");

-- CreateIndex
CREATE INDEX "api_endpoints_org_id_website_id_idx" ON "api_endpoints"("org_id", "website_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_credentials_api_endpoint_id_key" ON "api_credentials"("api_endpoint_id");

-- CreateIndex
CREATE INDEX "api_test_results_api_endpoint_id_checked_at_idx" ON "api_test_results"("api_endpoint_id", "checked_at" DESC);

-- CreateIndex
CREATE INDEX "sdk_events_website_id_received_at_idx" ON "sdk_events"("website_id", "received_at" DESC);

-- CreateIndex
CREATE INDEX "sdk_events_website_id_fingerprint_received_at_idx" ON "sdk_events"("website_id", "fingerprint", "received_at");

-- CreateIndex
CREATE INDEX "metrics_hourly_website_id_metric_bucket_idx" ON "metrics_hourly"("website_id", "metric", "bucket");

-- CreateIndex
CREATE INDEX "metrics_daily_website_id_metric_bucket_idx" ON "metrics_daily"("website_id", "metric", "bucket");

-- CreateIndex
CREATE UNIQUE INDEX "incident_rules_org_id_website_id_category_key" ON "incident_rules"("org_id", "website_id", "category");

-- CreateIndex
CREATE INDEX "incidents_org_id_status_severity_idx" ON "incidents"("org_id", "status", "severity");

-- CreateIndex
CREATE INDEX "incidents_org_id_fingerprint_resolved_at_idx" ON "incidents"("org_id", "fingerprint", "resolved_at");

-- CreateIndex
CREATE INDEX "incidents_website_id_first_detected_at_idx" ON "incidents"("website_id", "first_detected_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "incidents_org_id_number_key" ON "incidents"("org_id", "number");

-- CreateIndex
CREATE INDEX "incident_occurrences_incident_id_occurred_at_idx" ON "incident_occurrences"("incident_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "incident_events_incident_id_created_at_idx" ON "incident_events"("incident_id", "created_at");

-- CreateIndex
CREATE INDEX "incident_comments_incident_id_created_at_idx" ON "incident_comments"("incident_id", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_id_idx" ON "outbox_events"("published_at", "id");

-- CreateIndex
CREATE INDEX "notifications_user_id_org_id_read_at_created_at_idx" ON "notifications"("user_id", "org_id", "read_at", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_org_id_user_id_channel_key" ON "notification_preferences"("org_id", "user_id", "channel");

-- CreateIndex
CREATE INDEX "notification_channels_org_id_kind_idx" ON "notification_channels"("org_id", "kind");

-- CreateIndex
CREATE INDEX "notification_delivery_logs_org_id_created_at_idx" ON "notification_delivery_logs"("org_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notification_delivery_logs_idempotency_key_idx" ON "notification_delivery_logs"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_key_key" ON "subscription_plans"("key");

-- CreateIndex
CREATE UNIQUE INDEX "plan_prices_stripe_price_id_key" ON "plan_prices"("stripe_price_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_prices_razorpay_plan_id_key" ON "plan_prices"("razorpay_plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_prices_plan_id_interval_currency_version_key" ON "plan_prices"("plan_id", "interval", "currency", "version");

-- CreateIndex
CREATE UNIQUE INDEX "entitlement_overrides_org_id_key_key" ON "entitlement_overrides"("org_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_gateway_subscription_id_key" ON "subscriptions"("gateway_subscription_id");

-- CreateIndex
CREATE INDEX "subscriptions_org_id_status_idx" ON "subscriptions"("org_id", "status");

-- CreateIndex
CREATE INDEX "subscriptions_status_current_period_end_idx" ON "subscriptions"("status", "current_period_end");

-- CreateIndex
CREATE INDEX "trials_status_ends_at_idx" ON "trials"("status", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "trials_org_id_key" ON "trials"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_customers_org_id_gateway_key" ON "gateway_customers"("org_id", "gateway");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_customers_gateway_gateway_customer_id_key" ON "gateway_customers"("gateway", "gateway_customer_id");

-- CreateIndex
CREATE INDEX "payments_org_id_created_at_idx" ON "payments"("org_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "payments_gateway_gateway_payment_id_key" ON "payments"("gateway", "gateway_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices"("number");

-- CreateIndex
CREATE INDEX "invoices_org_id_issued_at_idx" ON "invoices"("org_id", "issued_at" DESC);

-- CreateIndex
CREATE INDEX "payment_webhook_events_status_received_at_idx" ON "payment_webhook_events"("status", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_webhook_events_gateway_event_id_key" ON "payment_webhook_events"("gateway", "event_id");

-- CreateIndex
CREATE INDEX "audit_logs_org_id_occurred_at_idx" ON "audit_logs"("org_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_action_occurred_at_idx" ON "audit_logs"("action", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_stream_seq_key" ON "audit_logs"("stream", "seq");

-- CreateIndex
CREATE INDEX "audit_anchors_stream_seq_idx" ON "audit_anchors"("stream", "seq");

-- CreateIndex
CREATE INDEX "security_events_kind_occurred_at_idx" ON "security_events"("kind", "occurred_at");

-- CreateIndex
CREATE INDEX "break_glass_requests_org_id_status_idx" ON "break_glass_requests"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "platform_setting_history_key_version_key" ON "platform_setting_history"("key", "version");

-- CreateIndex
CREATE INDEX "worker_heartbeats_kind_last_seen_at_idx" ON "worker_heartbeats"("kind", "last_seen_at");

-- CreateIndex
CREATE INDEX "system_health_logs_component_metric_recorded_at_idx" ON "system_health_logs"("component", "metric", "recorded_at");

-- CreateIndex
CREATE INDEX "job_failures_queue_failed_at_idx" ON "job_failures"("queue", "failed_at");

-- CreateIndex
CREATE INDEX "job_failures_resolved_at_idx" ON "job_failures"("resolved_at");

-- CreateIndex
CREATE INDEX "report_jobs_org_id_created_at_idx" ON "report_jobs"("org_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "data_requests_state_scheduled_for_idx" ON "data_requests"("state", "scheduled_for");

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "permissions"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_encryption_keys" ADD CONSTRAINT "org_encryption_keys_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_claims" ADD CONSTRAINT "domain_claims_domain_registry_id_fkey" FOREIGN KEY ("domain_registry_id") REFERENCES "domain_registry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_claims" ADD CONSTRAINT "domain_claims_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_verifications" ADD CONSTRAINT "domain_verifications_domain_claim_id_fkey" FOREIGN KEY ("domain_claim_id") REFERENCES "domain_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_registration_attempts" ADD CONSTRAINT "domain_registration_attempts_domain_registry_id_fkey" FOREIGN KEY ("domain_registry_id") REFERENCES "domain_registry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_transfers" ADD CONSTRAINT "domain_transfers_domain_registry_id_fkey" FOREIGN KEY ("domain_registry_id") REFERENCES "domain_registry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "websites" ADD CONSTRAINT "websites_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "websites" ADD CONSTRAINT "websites_domain_claim_id_fkey" FOREIGN KEY ("domain_claim_id") REFERENCES "domain_claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_installations" ADD CONSTRAINT "site_installations_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitoring_configurations" ADD CONSTRAINT "monitoring_configurations_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_recipes" ADD CONSTRAINT "auth_recipes_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discovered_pages" ADD CONSTRAINT "discovered_pages_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitored_pages" ADD CONSTRAINT "monitored_pages_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitored_pages" ADD CONSTRAINT "monitored_pages_discovered_page_id_fkey" FOREIGN KEY ("discovered_page_id") REFERENCES "discovered_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_components" ADD CONSTRAINT "page_components_monitored_page_id_fkey" FOREIGN KEY ("monitored_page_id") REFERENCES "monitored_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitoring_schedules" ADD CONSTRAINT "monitoring_schedules_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitoring_schedules" ADD CONSTRAINT "monitoring_schedules_api_endpoint_id_fkey" FOREIGN KEY ("api_endpoint_id") REFERENCES "api_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_endpoints" ADD CONSTRAINT "api_endpoints_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_api_endpoint_id_fkey" FOREIGN KEY ("api_endpoint_id") REFERENCES "api_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_rules" ADD CONSTRAINT "incident_rules_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_comments" ADD CONSTRAINT "incident_comments_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_entitlements" ADD CONSTRAINT "plan_entitlements_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlement_overrides" ADD CONSTRAINT "entitlement_overrides_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_price_id_fkey" FOREIGN KEY ("plan_price_id") REFERENCES "plan_prices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trials" ADD CONSTRAINT "trials_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_customers" ADD CONSTRAINT "gateway_customers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_setting_history" ADD CONSTRAINT "platform_setting_history_key_fkey" FOREIGN KEY ("key") REFERENCES "platform_settings"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_jobs" ADD CONSTRAINT "report_jobs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
