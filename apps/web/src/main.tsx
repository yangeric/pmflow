import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from './lib/auth'
import { ThemeProvider, applyStoredTheme } from './lib/theme'
import App from './App'
import './index.css'

// 在 React 掛載之前先套用，不然第一格畫面會閃一下白的
applyStoredTheme()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (count, err) => {
        // 401/403 重試沒有意義，只會多打幾次
        const status = (err as { status?: number }).status
        if (status === 401 || status === 403) return false
        return count < 2
      },
      refetchOnWindowFocus: false,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>
)
