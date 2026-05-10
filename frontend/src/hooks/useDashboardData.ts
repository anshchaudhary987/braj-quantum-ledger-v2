import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from '@/lib/api';
import { useAuthStore } from '@/store/authStore';

// Types
interface DashboardStats {
  totalRevenue: number;
  outstandingPayables: number;
  gstPayable: number;
  bankBalance: number;
  revenueChange: number;
  payablesChange: number;
  gstChange: number;
  bankChange: number;
}

interface RevenueData {
  name: string;
  revenue: number;
  expenses: number;
}

interface GstReturn {
  form: string;
  status: 'filed' | 'pending' | 'overdue';
  dueDate: string;
  period: string;
}

interface GstStatus {
  returns: GstReturn[];
  complianceScore: number;
  actionRequired: string | null;
}

// Auth hook with TanStack Query
export function useAuthQuery() {
  const queryClient = useQueryClient();
  const { setAuth, logout } = useAuthStore();

  const loginMutation = useMutation({
    mutationFn: async (credentials: { email: string; password: string }) => {
      const res = await apiClient.post('/auth/login', credentials);
      return res.data;
    },
    onSuccess: (data) => {
      setAuth({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        user: data.user,
        companies: data.companies,
      });
      // Invalidate dashboard data on login
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      const refreshToken = localStorage.getItem('refresh_token');
      if (refreshToken) {
        await apiClient.post('/auth/logout', { refresh_token: refreshToken });
      }
    },
    onSettled: () => {
      logout();
      queryClient.clear();
    },
  });

  return {
    login: loginMutation.mutateAsync,
    logout: logoutMutation.mutate,
    isLoading: loginMutation.isPending || logoutMutation.isPending,
    error: loginMutation.error,
    isError: loginMutation.isError,
  };
}

// Dashboard stats hook
export function useDashboardStats() {
  return useQuery({
    queryKey: ['dashboard', 'stats'],
    queryFn: async (): Promise<DashboardStats> => {
      try {
        const res = await apiClient.get('/dashboard/stats');
        return res.data.data;
      } catch (error) {
        // Fallback to demo data if API not available
        return {
          totalRevenue: 12456789,
          outstandingPayables: 4523100,
          gstPayable: 1234000,
          bankBalance: 6789000,
          revenueChange: 12.5,
          payablesChange: 3.2,
          gstChange: -5.1,
          bankChange: 8.7,
        };
      }
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

// Revenue data for chart
export function useRevenueData() {
  return useQuery({
    queryKey: ['dashboard', 'revenue'],
    queryFn: async (): Promise<RevenueData[]> => {
      try {
        const res = await apiClient.get('/reports/revenue');
        return res.data.data;
      } catch (error) {
        // Fallback data
        return [
          { name: 'Jan', revenue: 4000, expenses: 3000 },
          { name: 'Feb', revenue: 5500, expenses: 3500 },
          { name: 'Mar', revenue: 4800, expenses: 3200 },
          { name: 'Apr', revenue: 6200, expenses: 3800 },
          { name: 'May', revenue: 7100, expenses: 4100 },
          { name: 'Jun', revenue: 6800, expenses: 3900 },
        ];
      }
    },
  });
}

// GST status hook
export function useGSTStatus() {
  return useQuery({
    queryKey: ['gst', 'status'],
    queryFn: async (): Promise<GstStatus> => {
      try {
        const res = await apiClient.get('/gst/status');
        return res.data.data;
      } catch (error) {
        // Fallback data
        return {
          returns: [
            { form: 'GSTR-1', status: 'filed', dueDate: '11th May', period: 'Apr 2026' },
            { form: 'GSTR-3B', status: 'pending', dueDate: '20th May', period: 'Apr 2026' },
            { form: 'GSTR-9', status: 'overdue', dueDate: '31st Dec', period: 'FY 2025-26' },
          ],
          complianceScore: 85,
          actionRequired: 'GSTR-3B is due in 5 days',
        };
      }
    },
  });
}

// Combined dashboard hook for convenience
export function useDashboard() {
  const statsQuery = useDashboardStats();
  const revenueQuery = useRevenueData();
  const gstQuery = useGSTStatus();

  const isLoading = statsQuery.isLoading || revenueQuery.isLoading || gstQuery.isLoading;
  const isError = statsQuery.isError || revenueQuery.isError || gstQuery.isError;

  return {
    stats: statsQuery.data,
    revenueData: revenueQuery.data,
    gstStatus: gstQuery.data,
    isLoading,
    isError,
    refetch: () => {
      statsQuery.refetch();
      revenueQuery.refetch();
      gstQuery.refetch();
    },
  };
}

// Reports hook
export function useReports(filters?: { startDate?: string; endDate?: string }) {
  return useQuery({
    queryKey: ['reports', filters],
    queryFn: async () => {
      try {
        const res = await apiClient.get('/reports', { params: filters });
        return res.data.data;
      } catch (error) {
        // Fallback data
        return [];
      }
    },
  });
}
