/*
  Warnings:

  - You are about to drop the column `daemonTokenHash` on the `nodes` table. All the data in the column will be lost.
  - Added the required column `daemonTokenEncrypted` to the `nodes` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "nodes" DROP COLUMN "daemonTokenHash",
ADD COLUMN     "daemonTokenEncrypted" TEXT NOT NULL;
