-- call-bot :: MySQL schema
-- Engine: InnoDB, charset utf8mb4. Designed for a single-server deployment.
-- Create the database first:  CREATE DATABASE callbot CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- ---------------------------------------------------------------------------
-- Users. You create accounts via the create-user script (hashes the password).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username       VARCHAR(64)  NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  full_name      VARCHAR(128) NULL,
  role           ENUM('admin','user') NOT NULL DEFAULT 'user',
  is_active      TINYINT(1)   NOT NULL DEFAULT 1,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Caller IDs. Numbers presented as CLI on outbound calls (must be allowed by
-- your SIP trunk). Managed on the "Audio & Caller IDs" tab.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS caller_ids (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  label       VARCHAR(128) NOT NULL,
  number      VARCHAR(32)  NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_caller_ids_user (user_id),
  CONSTRAINT fk_caller_ids_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Audio library. Uploaded recordings, converted to 8kHz mono for Asterisk.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audio_files (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id           BIGINT UNSIGNED NOT NULL,
  name              VARCHAR(128) NOT NULL,           -- friendly label shown in dropdown
  original_filename VARCHAR(255) NOT NULL,
  stored_filename   VARCHAR(255) NOT NULL,           -- converted file Asterisk plays (no extension needed by Playback)
  format            VARCHAR(16)  NOT NULL DEFAULT 'wav',
  duration_sec      INT UNSIGNED NULL,
  status            ENUM('processing','ready','failed') NOT NULL DEFAULT 'processing',
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audio_user (user_id),
  CONSTRAINT fk_audio_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Campaigns. cps + max_concurrent are snapshotted from the chosen intensity
-- level so later config changes don't alter an in-flight campaign.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaigns (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  name            VARCHAR(128) NOT NULL,
  -- Broadcast channel: 'voice' dials via Asterisk, 'sms' blasts via the SMS
  -- gateway. Voice uses audio_file_id/caller_id_id; SMS uses message_template.
  channel         ENUM('voice','sms') NOT NULL DEFAULT 'voice',
  caller_id_id    BIGINT UNSIGNED NULL,
  audio_file_id   BIGINT UNSIGNED NULL,
  -- SMS body with {name}/{amount} placeholders, filled per-recipient at send.
  message_template TEXT NULL,
  intensity_level TINYINT      NOT NULL DEFAULT 1,   -- 1=Safe, 2=Balanced, 3=Fast
  cps             DECIMAL(4,1) NOT NULL DEFAULT 1.0, -- calls launched per second
  max_concurrent  INT UNSIGNED NOT NULL DEFAULT 20,  -- max simultaneous live calls
  max_attempts    TINYINT UNSIGNED NOT NULL DEFAULT 1,   -- total dials per number (1 = no retry)
  retry_delay_min INT UNSIGNED     NOT NULL DEFAULT 0,   -- minutes to wait before a retry
  retry_on        VARCHAR(64)      NOT NULL DEFAULT 'busy,no_answer,congestion,failed', -- outcomes that trigger a retry
  amd_enabled     TINYINT(1)       NOT NULL DEFAULT 0,    -- answering-machine detection (humans only)
  schedule_type   ENUM('now','scheduled') NOT NULL DEFAULT 'now',
  scheduled_at    DATETIME NULL,
  status          ENUM('draft','scheduled','running','paused','completed','stopped','failed')
                    NOT NULL DEFAULT 'draft',
  total_contacts  INT UNSIGNED NOT NULL DEFAULT 0,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at      DATETIME NULL,
  completed_at    DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_campaigns_user (user_id),
  KEY idx_campaigns_status (status),
  KEY idx_campaigns_scheduled (status, scheduled_at),
  CONSTRAINT fk_campaigns_user      FOREIGN KEY (user_id)       REFERENCES users(id)       ON DELETE CASCADE,
  CONSTRAINT fk_campaigns_callerid  FOREIGN KEY (caller_id_id)  REFERENCES caller_ids(id)  ON DELETE SET NULL,
  CONSTRAINT fk_campaigns_audio     FOREIGN KEY (audio_file_id) REFERENCES audio_files(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Contacts: the dial list for a campaign (name + phone only).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contacts (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  campaign_id BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(128) NULL,
  phone       VARCHAR(32)  NOT NULL,
  amount      VARCHAR(64)  NULL,   -- optional per-recipient value for the SMS {amount} variable
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_contacts_campaign (campaign_id),
  CONSTRAINT fk_contacts_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Call logs: one row per dial attempt. Source of truth for reports + monitor.
-- status maps to your report buckets: answered / busy / no_answer (+ failed,
-- congestion, machine for completeness). hangup_cause keeps the raw Q.850 code.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS call_logs (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  campaign_id   BIGINT UNSIGNED NOT NULL,
  contact_id    BIGINT UNSIGNED NULL,
  name          VARCHAR(128) NULL,
  phone         VARCHAR(32)  NOT NULL,
  amount        VARCHAR(64)  NULL,   -- SMS: per-recipient {amount} value, copied from contacts
  -- Voice outcomes: answered/busy/no_answer/failed/congestion/machine.
  -- SMS outcomes: 'sent' (gateway accepted) / 'failed'. 'dialing' doubles as the
  -- in-flight marker for SMS ("sending"). 'queued' = not yet dialed/sent.
  status        ENUM('queued','dialing','answered','busy','no_answer','failed','congestion','machine','sent')
                  NOT NULL DEFAULT 'queued',
  hangup_cause  INT NULL,          -- voice: Q.850 code; SMS: raw gateway status code
  error_detail  VARCHAR(255) NULL, -- SMS: human-readable failure reason (e.g. "Insufficient credit")
  channel       VARCHAR(128) NULL,            -- Asterisk channel id, for live monitor
  attempts      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME NULL,              -- when a requeued retry becomes eligible to dial
  dial_start    DATETIME NULL,
  answer_time   DATETIME NULL,
  end_time      DATETIME NULL,
  duration_sec  INT UNSIGNED NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_calllogs_campaign (campaign_id),
  KEY idx_calllogs_campaign_status (campaign_id, status),
  KEY idx_calllogs_queue (campaign_id, status, next_attempt_at),  -- retry-aware dial queue
  KEY idx_calllogs_channel (channel),
  CONSTRAINT fk_calllogs_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  CONSTRAINT fk_calllogs_contact  FOREIGN KEY (contact_id)  REFERENCES contacts(id)  ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
