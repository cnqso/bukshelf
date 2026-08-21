import { resolve } from 'node:path';
import {
  BackupError,
  createBackup,
  defaultBackupDestination,
  restoreBackup,
  verifyBackup,
} from './backup';
import { getDataDir, getDatabasePath } from './config';

const usage = () => {
  console.log(`Usage:
  bun src/backupCli.ts create [--output <directory>]
  bun src/backupCli.ts verify <backup-directory>
  bun src/backupCli.ts restore <backup-directory> --force

Stop the Bukshelf server before creating or restoring a backup. Restore replaces
the current SQLite database and the books, covers, and files directories.`);
};

const parseOutput = (args: string[]) => {
  const index = args.indexOf('--output');
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new BackupError('--output requires a directory');
  return resolve(value);
};

const main = async () => {
  const args = process.argv.slice(2);
  const command = args[0];
  const dataDir = getDataDir();
  const databasePath = getDatabasePath();

  if (command === 'create') {
    const destination = parseOutput(args) ?? defaultBackupDestination(dataDir);
    const result = await createBackup({ dataDir, databasePath, destination });
    const bytes = result.manifest.files.reduce((sum, file) => sum + file.size, 0);
    console.log(`Created backup ${result.path}`);
    console.log(`${result.manifest.files.length} files, ${bytes} bytes`);
    return;
  }

  if (command === 'verify') {
    const backupPath = args[1];
    if (!backupPath) throw new BackupError('verify requires a backup directory');
    const manifest = await verifyBackup(backupPath);
    console.log(`Verified ${resolve(backupPath)}`);
    console.log(`${manifest.files.length} files from ${manifest.createdAt}`);
    return;
  }

  if (command === 'restore') {
    const backupPath = args.find((argument, index) => index > 0 && !argument.startsWith('--'));
    if (!backupPath) throw new BackupError('restore requires a backup directory');
    if (!args.includes('--force'))
      throw new BackupError(
        'restore replaces current data; rerun with --force after stopping the server',
      );
    const manifest = await restoreBackup({ dataDir, databasePath, backupPath });
    console.log(`Restored ${resolve(backupPath)}`);
    console.log(`${manifest.files.length} files from ${manifest.createdAt}`);
    return;
  }

  usage();
  process.exitCode = 1;
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
