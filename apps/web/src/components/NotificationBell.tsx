import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Api, type AppNotification, type LinkType, type ProjectRole } from '../lib/api'
import { T } from '../strings'
import { cx } from './ui'

/**
 * 通知鈴鐺 —— 系統唯一一個「主動告訴你發生了什麼事」的地方。
 *
 * 為什麼是鈴鐺而不是常駐橫條：四種事件加起來，多數日子是零則。
 * 一條永遠空著的橫條會佔掉每個畫面的一行，而且久了就沒人看。
 * 鈴鐺沒有未讀時只是一個灰色圖示，有未讀才跳數字。
 *
 * 為什麼是輪詢：後端沒有 WebSocket 也沒有寄信（見 docs/CODEMAP.md）。
 * 30 秒一次對自架的小團隊足夠即時，也不會讓 Postgres 忙起來 ——
 * 未讀數走的是 notification 的部分索引，只掃未讀的那幾列。
 */

const POLL_MS = 30_000

const N = T.nav.notification

export function NotificationBell({
  onOpen, placement = 'down',
}: {
  /** 點某一則 → 跳到那件事發生的地方。要跳去哪由 App 決定，這裡只負責交出那一則 */
  onOpen: (n: AppNotification) => void
  /** 鈴鐺在畫面下緣（側欄底部）時要往上展開，不然清單會掉出視窗外 */
  placement?: 'down' | 'up'
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => Api.notifications(),
    refetchInterval: POLL_MS,
    // 分頁在背景時不必一直問，切回來會立刻重抓
    refetchIntervalInBackground: false,
  })
  const items = data?.items ?? []
  const unread = data?.unread ?? 0

  const markRead = useMutation({
    mutationFn: (id: string) => Api.markNotificationRead(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  })
  const markAll = useMutation({
    mutationFn: () => Api.markAllNotificationsRead(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  })

  // 點別的地方就收起來。用 mousedown 而不是 click：
  // click 要等到放開才觸發，中間拖曳選字會讓清單看起來卡住不關
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  function pick(n: AppNotification) {
    setOpen(false)
    if (!n.readAt) markRead.mutate(n.id)
    onOpen(n)
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        aria-label={unread > 0 ? N.unreadAria(unread) : N.title}
        aria-expanded={open}
        className={cx(
          'relative rounded-md px-2 py-1 text-base leading-none transition-colors',
          open ? 'bg-slate-100 dark:bg-slate-800' : 'hover:bg-slate-100 dark:hover:bg-slate-800'
        )}>
        <span aria-hidden className={unread > 0 ? '' : 'opacity-50 grayscale'}>🔔</span>
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 min-w-[1.1rem] rounded-full bg-red-500 px-1
                           text-center text-[10px] font-semibold leading-[1.1rem] text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {/* 展開方向跟著鈴鐺站的位置走：
          頂端的鈴鐺靠右，清單往左下長；側欄底部的鈴鐺離左緣只有 250px，
          再往左長就會被視窗切掉，所以往右下長 */}
      {open && (
        <div className={cx(
          'absolute z-50 w-80 overflow-hidden rounded-lg bg-white shadow-lg ring-1 ring-slate-200',
          'dark:bg-slate-800 dark:ring-slate-700',
          placement === 'up' ? 'bottom-full left-0 mb-2' : 'top-full right-0 mt-2'
        )}>
          <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2
                          dark:border-slate-700">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{N.title}</span>
            {unread > 0 && (
              <button onClick={() => markAll.mutate()} disabled={markAll.isPending}
                      className="ml-auto text-xs text-slate-400 hover:text-slate-600
                                 dark:text-slate-400 dark:hover:text-slate-300">
                {N.markAllRead}
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs leading-relaxed text-slate-400
                              dark:text-slate-400">
                {N.emptyTitle}<br />
                {N.emptyHint}
              </div>
            ) : items.map(n => (
              <button
                key={n.id}
                onClick={() => pick(n)}
                className={cx(
                  'block w-full border-b border-slate-100 px-3 py-2.5 text-left last:border-0',
                  'dark:border-slate-700',
                  n.readAt
                    ? 'hover:bg-slate-50 dark:hover:bg-slate-700'
                    : 'bg-blue-50/50 hover:bg-blue-50 dark:bg-blue-500/10 dark:hover:bg-blue-500/20'
                )}>
                <div className="flex items-start gap-2">
                  <span aria-hidden className="mt-0.5 shrink-0 text-sm">{ICON[n.kind]}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] leading-snug text-slate-700 dark:text-slate-200">
                      {headline(n)}
                    </div>
                    {detail(n) && (
                      <div className="mt-0.5 text-xs leading-snug text-slate-500 dark:text-slate-400">
                        {detail(n)}
                      </div>
                    )}
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-400
                                    dark:text-slate-400">
                      <span>{relativeTime(n.createdAt)}</span>
                      {n.projectKey && (
                        <>
                          <span className="text-slate-300 dark:text-slate-500">·</span>
                          <span className="truncate">{n.projectName ?? n.projectKey}</span>
                        </>
                      )}
                    </div>
                  </div>
                  {!n.readAt && (
                    <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" />
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const ICON: Record<AppNotification['kind'], string> = {
  TASK_LINKED: '🔗', TASK_ASSIGNED: '📌', JOIN_REQUESTED: '🙋', JOIN_APPROVED: '✅',
}

/** 一句話講完發生了什麼事，主詞是做這件事的人 */
function headline(n: AppNotification): string {
  const who = n.actorName ?? N.someone
  const task = n.taskTitle ? N.quoted(n.taskTitle) : N.someTask
  const project = n.projectName ? N.quoted(n.projectName) : N.yourProject
  switch (n.kind) {
    case 'TASK_LINKED': {
      // 兩張任務都要指名道姓。只講「指向你的任務」的話，看的人不知道是誰關聯了誰
      const other = n.body?.otherTitle as string | undefined
      return other
        ? N.linkedTo(who, N.quoted(other), task)
        : N.linkedPlain(who, task)
    }
    case 'TASK_ASSIGNED':
      return N.assigned(who, task)
    case 'JOIN_REQUESTED':
      return N.joinRequested(who, project)
    case 'JOIN_APPROVED':
      return n.body?.direct
        ? N.joinAdded(who, project)
        : N.joinApproved(who, project)
  }
}

/** 補一句細節。沒有值得補的就回 null，不要留一行空白 */
function detail(n: AppNotification): string | null {
  const b = n.body ?? {}
  switch (n.kind) {
    case 'TASK_LINKED': {
      const type = b.linkType as LinkType | undefined
      if (!type) return null
      const other = [b.otherRef, b.otherTitle].filter(Boolean).join(' ') || N.otherTask
      return linkedSentence(type, N.quoted(n.taskTitle ?? N.yourTask), other)
    }
    case 'TASK_ASSIGNED': {
      // 轉派時寫的那句交接說明。它是這則通知裡最要緊的一句話 ——
      // 「為什麼換到我頭上、做到哪裡了」比任務編號有用得多，所以排在編號前面
      const note = (b.note as string | null) || null
      return [note && N.quoted(note), n.taskRef].filter(Boolean).join('　') || null
    }
    case 'JOIN_REQUESTED':
      return (b.message as string | null) || null
    case 'JOIN_APPROVED': {
      const role = b.role as ProjectRole | undefined
      const note = (b.note as string | null) || null
      const parts = [role ? N.roleIs(N.role[role]) : null, note]
      return parts.filter(Boolean).join('　') || null
    }
  }
}

/**
 * 被指向這一端看到的完整句子。
 *
 * 刻意不用 lib/linkText 的 linkSentence —— 那一支的主詞是「我」，因為它畫在
 * 任務詳情裡，「我」自然指當下開著的那張。通知是在別的地方看到的，
 * 「我」會被讀成收通知的人，所以這裡兩張任務都寫名字，一個代名詞都不留。
 *
 * mine＝被指向的任務（收通知的人負責的），other＝對方建立關聯的那張。
 */
function linkedSentence(type: LinkType, mine: string, other: string): string {
  return N.link[type](mine, other)
}

/**
 * 相對時間。刻意不放進 lib/date.ts —— 那個檔處理的是「不帶時間的日曆日」，
 * 開頭就寫明不把日期當時間點看。通知的時間戳是真正的瞬間，是不同的東西。
 */
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60_000)
  if (min < 1) return N.time.justNow
  if (min < 60) return N.time.minutes(min)
  const hr = Math.floor(min / 60)
  if (hr < 24) return N.time.hours(hr)
  const day = Math.floor(hr / 24)
  if (day < 7) return N.time.days(day)
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}
