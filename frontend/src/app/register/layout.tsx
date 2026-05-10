import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Register — GLM Ledger',
  description: 'Create your GLM Ledger account',
};

export default function RegisterLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
