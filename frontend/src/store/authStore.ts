import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { UserProfile, CompanyBrief } from '@/types/api';

interface AuthState {
  user: UserProfile | null;
  companies: CompanyBrief[];
  token: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  
  setAuth: (data: { access_token: string; refresh_token: string; user: UserProfile; companies: CompanyBrief[] }) => void;
  logout: () => void;
  setLoading: (loading: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      companies: [],
      token: null,
      refreshToken: null,
      isAuthenticated: false,
      isLoading: true,
      
      setAuth: (data) => {
        localStorage.setItem('access_token', data.access_token);
        localStorage.setItem('refresh_token', data.refresh_token);
        set({
          user: data.user,
          companies: data.companies,
          token: data.access_token,
          refreshToken: data.refresh_token,
          isAuthenticated: true,
          isLoading: false,
        });
      },
      
      logout: () => {
        localStorage.removeItem('access_token');
        localStorage.removeItem('refresh_token');
        set({
          user: null,
          companies: [],
          token: null,
          refreshToken: null,
          isAuthenticated: false,
          isLoading: false,
        });
      },
      
      setLoading: (loading) => set({ isLoading: loading }),
    }),
    {
      name: 'glm-auth-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        user: state.user,
        companies: state.companies,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);
