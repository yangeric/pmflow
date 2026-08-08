import { useMemo, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Api, type AppNotification } from './api'

/**
 * 追蹤未讀通知對應的任務/事件 ID，並提供點擊時標記已讀的 handler。
 * 當有未讀通知時，對應的任務框會套用 `.pmflow-flash` 閃紅框，直到使用者點進去。
 */
export function useUnreadNotifications() {
  const qc = useQueryClient()

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => Api.notifications(),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })

  const items = useMemo(() => data?.items ?? [], [data?.items])

  const unreadItems = useMemo(
    () => items.filter((n: AppNotification) => !n.readAt),
    [items]
  )

  const unreadTaskIds = useMemo(() => {
    const ids = new Set<string>()
    for (const n of unreadItems) {
      if (n.taskId) ids.add(n.taskId)
    }
    return ids
  }, [unreadItems])

  const markNotificationRead = useMutation({
    mutationFn: (id: string) => Api.markNotificationRead(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  })

  const markTaskRead = useCallback(
    async (taskId: string) => {
      const targets = unreadItems.filter(n => n.taskId === taskId)
      if (targets.length === 0) return
      await Promise.all(targets.map(n => Api.markNotificationRead(n.id)))
      qc.invalidateQueries({ queryKey: ['notifications'] })
    },
    [unreadItems, qc]
  )

  return {
    items,
    unreadItems,
    unreadTaskIds,
    markTaskRead,
    markNotificationRead: markNotificationRead.mutate,
  }
}
