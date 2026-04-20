/*
  Warnings:

  - You are about to drop the column `emailVerifiedAt` on the `buyers` table. All the data in the column will be lost.
  - You are about to drop the column `lastLoginAt` on the `buyers` table. All the data in the column will be lost.
  - You are about to drop the column `passwordHash` on the `buyers` table. All the data in the column will be lost.
  - You are about to drop the column `phone` on the `buyers` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "buyers" DROP COLUMN "emailVerifiedAt",
DROP COLUMN "lastLoginAt",
DROP COLUMN "passwordHash",
DROP COLUMN "phone",
ADD COLUMN     "lastSyncAt" TIMESTAMP(3),
ALTER COLUMN "name" DROP NOT NULL;
