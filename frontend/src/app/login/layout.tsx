import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Login — GLM Ledger',
  description: 'Sign in to your GLM Ledger account',
};

export default function LoginLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
