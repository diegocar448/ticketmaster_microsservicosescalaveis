/*
  Warnings:

  - You are about to drop the column `planExpiresAt` on the `organizers` table. All the data in the column will be lost.
  - You are about to drop the column `stripeCustomerId` on the `organizers` table. All the data in the column will be lost.
  - You are about to drop the column `trialEndsAt` on the `organizers` table. All the data in the column will be lost.
  - You are about to drop the `organizer_users` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "organizer_users" DROP CONSTRAINT "organizer_users_organizerId_fkey";

-- DropIndex
DROP INDEX "organizers_stripeCustomerId_key";

-- AlterTable
ALTER TABLE "organizers" DROP COLUMN "planExpiresAt",
DROP COLUMN "stripeCustomerId",
DROP COLUMN "trialEndsAt",
ADD COLUMN     "lastSyncAt" TIMESTAMP(3);

-- DropTable
DROP TABLE "organizer_users";
