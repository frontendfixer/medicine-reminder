CREATE TYPE "public"."dose_status" AS ENUM('pending', 'snoozed', 'taken', 'not_taken', 'missed');--> statement-breakpoint
CREATE TYPE "public"."lockscreen_detail" AS ENUM('full', 'generic');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('backup', 'missed', 'correction', 'device_health', 'not_taken', 'window_low', 'billing', 'pairing', 'sync');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('standard', 'alarm', 'gentle');--> statement-breakpoint
CREATE TYPE "public"."pairing_code_kind" AS ENUM('pair', 'transfer');--> statement-breakpoint
CREATE TYPE "public"."patient_status" AS ENUM('active', 'suspended', 'archived');--> statement-breakpoint
CREATE TYPE "public"."patient_type" AS ENUM('managed', 'self');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('ios', 'android');--> statement-breakpoint
CREATE TYPE "public"."schedule_pattern" AS ENUM('daily', 'weekdays', 'every_n_days');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'store_grace', 'grace', 'expired');--> statement-breakpoint
CREATE TYPE "public"."tz_mode" AS ENUM('follow_device', 'fixed');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"patient_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_actor_type" CHECK ("audit_log"."actor_type" in ('caregiver','device','system'))
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid,
	"refresh_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "caregiver_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"default_missed_delay_min" integer DEFAULT 30 NOT NULL,
	"lockscreen_detail" "lockscreen_detail" DEFAULT 'full' NOT NULL,
	"daily_summary" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "missed_delay_positive" CHECK ("caregiver_settings"."default_missed_delay_min" > 0)
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"subject_type" text NOT NULL,
	"user_id" uuid,
	"patient_id" uuid,
	"device_id" uuid,
	"kind" text NOT NULL,
	"notice_version" text NOT NULL,
	"given_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "consents_subject" CHECK ("consents"."subject_type" in ('caregiver','patient')),
	CONSTRAINT "consents_kind" CHECK ("consents"."kind" in ('signup','pairing'))
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid,
	"patient_id" uuid,
	"token_hash" text,
	"push_token" text,
	"push_invalid_at" timestamp with time zone,
	"platform" "platform" NOT NULL,
	"label" text,
	"app_version" text,
	"tz" text,
	"perm_notifications" boolean,
	"perm_exact_alarm" boolean,
	"perm_battery_unrestricted" boolean,
	"perm_time_sensitive" boolean,
	"scheduled_through" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_one_owner" CHECK (("devices"."user_id" is null) <> ("devices"."patient_id" is null)),
	CONSTRAINT "devices_patient_has_token" CHECK ("devices"."patient_id" is null or "devices"."token_hash" is not null)
);
--> statement-breakpoint
CREATE TABLE "dose_instances" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"patient_id" uuid NOT NULL,
	"medicine_id" uuid NOT NULL,
	"schedule_version_id" uuid NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"local_time" time NOT NULL,
	"name_snapshot" "bytea" NOT NULL,
	"amount_snapshot" text NOT NULL,
	"alert_due_at" timestamp with time zone NOT NULL,
	"status" "dose_status" DEFAULT 'pending' NOT NULL,
	"snooze_until" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"client_event_id" uuid,
	"push_sent_at" timestamp with time zone,
	"alert_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dose_medicine_time_uq" UNIQUE("medicine_id","scheduled_at")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"principal" uuid NOT NULL,
	"key" text NOT NULL,
	"method_path" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" smallint,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_principal_key_pk" PRIMARY KEY("principal","key")
);
--> statement-breakpoint
CREATE TABLE "medicines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"patient_id" uuid NOT NULL,
	"name" "bytea" NOT NULL,
	"notes" "bytea",
	"photo_object_key" text,
	"notification_type" "notification_type" DEFAULT 'standard' NOT NULL,
	"missed_delay_min" integer,
	"stock_count" integer,
	"low_stock_at" integer,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medicines_missed_delay_positive" CHECK ("medicines"."missed_delay_min" is null or "medicines"."missed_delay_min" > 0)
);
--> statement-breakpoint
CREATE TABLE "notification_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"patient_id" uuid,
	"device_id" uuid,
	"dose_instance_id" uuid,
	"group_key" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"expo_ticket_id" text,
	"ticket_status" text,
	"ticket_error" text,
	"receipt_status" text,
	"receipt_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"receipt_checked_at" timestamp with time zone,
	CONSTRAINT "nlog_status" CHECK ("notification_log"."status" in ('queued','sent','failed'))
);
--> statement-breakpoint
CREATE TABLE "pairing_codes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" "pairing_code_kind" NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"lookup_hash" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"failed_attempts" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patients" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"display_name" "bytea" NOT NULL,
	"type" "patient_type" DEFAULT 'managed' NOT NULL,
	"timezone" text NOT NULL,
	"tz_mode" "tz_mode" DEFAULT 'follow_device' NOT NULL,
	"missed_delay_min" integer,
	"lockscreen_detail" "lockscreen_detail",
	"status" "patient_status" DEFAULT 'active' NOT NULL,
	"suspended_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patients_missed_delay_positive" CHECK ("patients"."missed_delay_min" is null or "patients"."missed_delay_min" > 0)
);
--> statement-breakpoint
CREATE TABLE "rc_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"app_user_id" text,
	"event_timestamp" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "schedule_times" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"schedule_version_id" uuid NOT NULL,
	"local_time" time NOT NULL,
	"amount_text" text NOT NULL,
	CONSTRAINT "schedule_times_uq" UNIQUE("schedule_version_id","local_time")
);
--> statement-breakpoint
CREATE TABLE "schedule_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"medicine_id" uuid NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_until" timestamp with time zone,
	"pattern" "schedule_pattern" NOT NULL,
	"days_of_week" smallint[],
	"interval_days" smallint,
	"start_date" date NOT NULL,
	"end_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sv_weekdays" CHECK ("schedule_versions"."pattern" <> 'weekdays' or coalesce(cardinality("schedule_versions"."days_of_week") between 1 and 7 and "schedule_versions"."days_of_week" <@ array[1,2,3,4,5,6,7]::smallint[], false)),
	CONSTRAINT "sv_interval" CHECK ("schedule_versions"."pattern" <> 'every_n_days' or coalesce("schedule_versions"."interval_days" >= 2, false)),
	CONSTRAINT "sv_dates" CHECK ("schedule_versions"."end_date" is null or "schedule_versions"."end_date" >= "schedule_versions"."start_date")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"plan" text NOT NULL,
	"patient_limit" integer NOT NULL,
	"status" "subscription_status" NOT NULL,
	"renews_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"cutoff_at" timestamp with time zone,
	"provider_ref" text NOT NULL,
	"last_event_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caregiver_settings" ADD CONSTRAINT "caregiver_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dose_instances" ADD CONSTRAINT "dose_instances_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dose_instances" ADD CONSTRAINT "dose_instances_medicine_id_medicines_id_fk" FOREIGN KEY ("medicine_id") REFERENCES "public"."medicines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dose_instances" ADD CONSTRAINT "dose_instances_schedule_version_id_schedule_versions_id_fk" FOREIGN KEY ("schedule_version_id") REFERENCES "public"."schedule_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicines" ADD CONSTRAINT "medicines_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_dose_instance_id_dose_instances_id_fk" FOREIGN KEY ("dose_instance_id") REFERENCES "public"."dose_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_times" ADD CONSTRAINT "schedule_times_schedule_version_id_schedule_versions_id_fk" FOREIGN KEY ("schedule_version_id") REFERENCES "public"."schedule_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_versions" ADD CONSTRAINT "schedule_versions_medicine_id_medicines_id_fk" FOREIGN KEY ("medicine_id") REFERENCES "public"."medicines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_patient_idx" ON "audit_log" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_one_active_uq" ON "auth_sessions" USING btree ("user_id") WHERE "auth_sessions"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_refresh_uq" ON "auth_sessions" USING btree ("refresh_hash");--> statement-breakpoint
CREATE INDEX "consents_user_idx" ON "consents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "consents_patient_idx" ON "consents" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_token_hash_uq" ON "devices" USING btree ("token_hash") WHERE "devices"."token_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "devices_one_caregiver_login_uq" ON "devices" USING btree ("user_id") WHERE "devices"."user_id" is not null and "devices"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "devices_patient_active_idx" ON "devices" USING btree ("patient_id") WHERE "devices"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "dose_client_event_uq" ON "dose_instances" USING btree ("client_event_id") WHERE "dose_instances"."client_event_id" is not null;--> statement-breakpoint
CREATE INDEX "dose_push_due_idx" ON "dose_instances" USING btree ("scheduled_at") WHERE "dose_instances"."push_sent_at" is null and "dose_instances"."status" in ('pending','snoozed');--> statement-breakpoint
CREATE INDEX "dose_alert_due_idx" ON "dose_instances" USING btree ("alert_due_at") WHERE "dose_instances"."alert_sent_at" is null and "dose_instances"."status" in ('pending','snoozed');--> statement-breakpoint
CREATE INDEX "dose_patient_time_idx" ON "dose_instances" USING btree ("patient_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "idempotency_created_idx" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "medicines_patient_idx" ON "medicines" USING btree ("patient_id") WHERE "medicines"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "nlog_queued_idx" ON "notification_log" USING btree ("created_at") WHERE "notification_log"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "nlog_receipt_due_idx" ON "notification_log" USING btree ("sent_at") WHERE "notification_log"."expo_ticket_id" is not null and "notification_log"."receipt_checked_at" is null;--> statement-breakpoint
CREATE INDEX "nlog_device_kind_idx" ON "notification_log" USING btree ("device_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "nlog_patient_kind_idx" ON "notification_log" USING btree ("patient_id","kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pairing_codes_live_uq" ON "pairing_codes" USING btree ("patient_id","kind") WHERE "pairing_codes"."used_at" is null and "pairing_codes"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "pairing_codes_lookup_idx" ON "pairing_codes" USING btree ("lookup_hash") WHERE "pairing_codes"."used_at" is null and "pairing_codes"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "patients_owner_idx" ON "patients" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "patients_one_self_uq" ON "patients" USING btree ("owner_user_id") WHERE "patients"."type" = 'self' and "patients"."status" <> 'archived';--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_versions_current_uq" ON "schedule_versions" USING btree ("medicine_id") WHERE "schedule_versions"."effective_until" is null;--> statement-breakpoint
CREATE INDEX "subscriptions_cutoff_idx" ON "subscriptions" USING btree ("cutoff_at") WHERE "subscriptions"."status" = 'grace';--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");