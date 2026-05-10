import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Dashboard — GLM Ledger',
  description: 'Your financial command center',
};

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
