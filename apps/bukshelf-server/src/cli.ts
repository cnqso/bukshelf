import { randomUUID } from 'node:crypto';
import { SQL } from 'bun';
import { AuthStore } from './authStore';
import { getDatabasePath, getLegacyDatabaseUrl } from './config';

const args = process.argv.slice(2);
const passwordFromStdin = args.includes('--password-stdin');
const emailIndex = args.indexOf('--email');
const emailArgument = emailIndex === -1 ? undefined : args[emailIndex + 1];
const positional = args.filter(
  (argument, index) =>
    argument !== '--password-stdin' && index !== emailIndex && index !== emailIndex + 1,
);

const usage = () => {
  console.log(`Usage:
  bun src/cli.ts auth setup [--email owner@example.com] [--password-stdin]
  bun src/cli.ts auth import-legacy [--email owner@example.com]
  bun src/cli.ts auth reset [--password-stdin]

With --password-stdin, provide the password as the first line of stdin.`);
};

const readHiddenPassword = (label: string): string => {
  if (!process.stdin.isTTY) throw new Error('Use --password-stdin when stdin is not a terminal');
  Bun.spawnSync(['stty', '-echo'], { stdin: 'inherit', stdout: 'ignore', stderr: 'ignore' });
  try {
    return prompt(label) ?? '';
  } finally {
    Bun.spawnSync(['stty', 'echo'], { stdin: 'inherit', stdout: 'ignore', stderr: 'ignore' });
    console.log();
  }
};

const readPassword = async (): Promise<string> => {
  if (passwordFromStdin) {
    const input = await Bun.stdin.text();
    return input.split(/\r?\n/, 1)[0] ?? '';
  }
  const password = readHiddenPassword('Password: ');
  const confirmation = readHiddenPassword('Confirm password: ');
  if (password !== confirmation) throw new Error('Passwords do not match');
  return password;
};

const validatePassword = (password: string) => {
  if (password.length < 12) throw new Error('Password must contain at least 12 characters');
};

const readOwnerEmail = () => {
  const email = (emailArgument ?? prompt('Owner email: ') ?? '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Enter a valid owner email');
  }
  return email;
};

const authSetup = async (store: AuthStore) => {
  if (store.getOwner()) throw new Error('Bukshelf owner is already configured');
  const email = readOwnerEmail();
  const password = await readPassword();
  validatePassword(password);
  store.createOwner({
    id: randomUUID(),
    email,
    passwordHash: await Bun.password.hash(password, { algorithm: 'argon2id' }),
  });
  console.log(`Configured Bukshelf owner ${email}`);
};

const importLegacyOwner = async (store: AuthStore) => {
  if (store.getOwner()) throw new Error('Bukshelf owner is already configured');
  const email = readOwnerEmail();
  const legacy = new SQL(getLegacyDatabaseUrl());
  try {
    const rows = await legacy`
      SELECT id, email, encrypted_password
      FROM auth.users
      WHERE lower(email) = lower(${email})
      LIMIT 1
    `;
    const owner = rows[0];
    if (!owner?.id || !owner.email || !owner.encrypted_password) {
      throw new Error(`No password owner found for ${email} in legacy auth`);
    }
    store.createOwner({
      id: owner.id,
      email: owner.email,
      passwordHash: owner.encrypted_password,
    });
    console.log(`Imported Bukshelf owner ${owner.email}; no password was copied in plaintext`);
  } finally {
    await legacy.close();
  }
};

const authReset = async (store: AuthStore) => {
  if (!store.getOwner()) throw new Error('Bukshelf owner is not configured');
  const password = await readPassword();
  validatePassword(password);
  store.resetPassword(await Bun.password.hash(password, { algorithm: 'argon2id' }));
  console.log('Password reset; all existing sessions were revoked');
};

const main = async () => {
  if (
    positional[0] !== 'auth' ||
    !['setup', 'import-legacy', 'reset'].includes(positional[1] ?? '')
  ) {
    usage();
    process.exitCode = 1;
    return;
  }

  const store = new AuthStore(getDatabasePath());
  try {
    if (positional[1] === 'setup') await authSetup(store);
    if (positional[1] === 'import-legacy') await importLegacyOwner(store);
    if (positional[1] === 'reset') await authReset(store);
  } finally {
    store.close();
  }
};

await main();
