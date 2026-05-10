import { useState } from 'react';
import { useRouter } from 'next/navigation';
import apiClient from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { LoginRequest, LoginResponse } from '@/types/api';

export function useAuth() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const { setAuth, logout } = useAuthStore();

  const login = async (credentials: LoginRequest) => {
    setIsLoading(true);
    setError(null);
    
    try {
      const response = await apiClient.post<LoginResponse>('/auth/login', credentials);
      const data = response.data;
      
      setAuth({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        user: data.user,
        companies: data.companies,
      });
      
      router.push('/dashboard');
      return true;
    } catch (err: any) {
      const message = err.response?.data?.error?.message || 'Login failed. Please try again.';
      setError(message);
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const register = async (data: { name: string; email: string; password: string; company_name: string }) => {
    setIsLoading(true);
    setError(null);
    
    try {
      // Note: Backend doesn't have a register endpoint yet, 
      // so this would need backend support
      const response = await apiClient.post('/auth/register', data);
      return true;
    } catch (err: any) {
      const message = err.response?.data?.error?.message || 'Registration failed. Please try again.';
      setError(message);
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      const refreshToken = localStorage.getItem('refresh_token');
      if (refreshToken) {
        await apiClient.post('/auth/logout', { refresh_token: refreshToken });
      }
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      logout();
      router.push('/');
    }
  };

  return {
    login,
    register,
    logout: handleLogout,
    isLoading,
    error,
    setError,
  };
}
