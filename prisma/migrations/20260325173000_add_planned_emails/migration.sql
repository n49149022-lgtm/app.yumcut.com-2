CREATE TABLE `PlannedEmail` (
  `id` char(36) NOT NULL,
  `userId` char(36) NOT NULL,
  `email` varchar(320) NOT NULL,
  `kind` varchar(64) NOT NULL,
  `targetLanguage` varchar(8) NOT NULL DEFAULT 'en',
  `scheduledAt` datetime(3) NOT NULL,
  `status` varchar(32) NOT NULL DEFAULT 'pending',
  `attempts` integer NOT NULL DEFAULT 0,
  `sentAt` datetime(3) NULL,
  `lastError` text NULL,
  `lockId` char(36) NULL,
  `lockedAt` datetime(3) NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL,

  UNIQUE INDEX `PlannedEmail_userId_kind_key`(`userId`, `kind`),
  INDEX `PlannedEmail_status_scheduledAt_idx`(`status`, `scheduledAt`),
  INDEX `PlannedEmail_lockId_lockedAt_idx`(`lockId`, `lockedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `PlannedEmail`
  ADD CONSTRAINT `PlannedEmail_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
