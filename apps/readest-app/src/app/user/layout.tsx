import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Account & Sign In',
  description: `Sign in to your ${process.env['SELF_HOSTED_BRAND_NAME'] || 'Readest'} account or manage cloud library storage and account settings.`,
};

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
